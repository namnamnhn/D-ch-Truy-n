import path from 'path';
import { createReadStream } from 'node:fs';
import { cp, stat } from 'node:fs/promises';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { providerGatewayPlugin } from './server/providerGateway';

const PDFJS_ASSET_ROUTE = '/pdfjs-assets/';
const PDFJS_ASSET_DIRECTORIES = ['cmaps', 'iccs', 'standard_fonts', 'wasm'] as const;

const pdfjsLocalAssets = (): Plugin => {
  const pdfjsRoot = path.resolve(__dirname, 'node_modules/pdfjs-dist');

  return {
    name: 'pdfjs-local-assets',
    configureServer(server) {
      server.middlewares.use(PDFJS_ASSET_ROUTE, async (request, response, next) => {
        try {
          const rawPath = decodeURIComponent((request.url || '').split('?')[0]).replace(/^\/+/, '');
          const relativePath = rawPath.startsWith('pdfjs-assets/')
            ? rawPath.slice('pdfjs-assets/'.length)
            : rawPath;
          const isApprovedAsset = PDFJS_ASSET_DIRECTORIES.some(
            directory => relativePath === directory || relativePath.startsWith(`${directory}/`),
          );
          if (!isApprovedAsset) return next();

          const resolvedPath = path.resolve(pdfjsRoot, relativePath);
          if (!resolvedPath.startsWith(`${pdfjsRoot}${path.sep}`)) return next();
          if (!(await stat(resolvedPath)).isFile()) return next();

          const extension = path.extname(resolvedPath).toLowerCase();
          response.setHeader('Content-Type', extension === '.wasm' ? 'application/wasm' : 'application/octet-stream');
          createReadStream(resolvedPath).pipe(response);
        } catch {
          next();
        }
      });
    },
    async writeBundle(options) {
      const outputDirectory = path.resolve(__dirname, options.dir || 'dist');
      await Promise.all(PDFJS_ASSET_DIRECTORIES.map(directory =>
        cp(
          path.join(pdfjsRoot, directory),
          path.join(outputDirectory, 'pdfjs-assets', directory),
          { recursive: true },
        ),
      ));
    },
  };
};

export default defineConfig(() => {
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      build: {
        target: 'esnext',
        rollupOptions: {
          output: {
            // TÁI CẤU TRÚC BUNDLE: chunk chính từng đạt ~2.18MB vì toàn bộ dependency nằm
            // chung 1 file. Tách theo nhóm vendor để trình duyệt tải song song + cache riêng
            // từng nhóm (khi nâng cấp app, vendor không đổi vẫn được tái sử dụng từ cache).
            // NÂNG CẤP (mục 4.2): pdfjs/docx/jszip đã chuyển sang DYNAMIC import tại điểm gọi
            // (parsers.ts/exporters.ts) và KHÔNG còn được liệt kê trong manualChunks nữa —
            // Rollup tự đặt chúng vào các chunk lazy riêng, chỉ tải khi người dùng thực sự
            // nhập/xuất tài liệu, không còn nằm trong initial load.
            // FIX (bundle split thật sự lỏng lẻo): dạng object ở trên chỉ khớp import CHÍNH XÁC
            // 'react'/'react-dom' — nhưng React 19 + code hiện dùng `react-dom/client` (subpath)
            // để mount app, Rollup không coi đó là cùng module với 'react-dom' nên toàn bộ
            // react-dom (~190KB) vẫn lọt vào main bundle thay vì vào 'vendor-react' (kết quả:
            // vendor-react build ra chỉ ~3-4KB — vô dụng, main bundle vẫn to như chưa tách).
            // SỬA: chuyển sang dạng function, so khớp theo ĐƯỜNG DẪN thật trong node_modules
            // (bắt được mọi subpath: react-dom, react-dom/client, react/jsx-runtime...) thay vì
            // so khớp tên module import tĩnh.
            manualChunks(id) {
              if (id.includes('node_modules')) {
                if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/') || id.includes('node_modules/scheduler')) {
                  return 'vendor-react';
                }
                if (id.includes('node_modules/lucide-react')) {
                  return 'vendor-icons';
                }
              }
              // Prompt template (constants/prompts) khá nặng chữ và ít đổi so với code logic —
              // tách riêng để trình duyệt cache lâu dài, không phải tải lại mỗi lần vá UI.
              if (id.includes('/src/prompts')) {
                return 'app-prompts';
              }
            }
          }
        }
      },
      optimizeDeps: {
        esbuildOptions: {
          target: 'esnext'
        }
      },
      plugins: [react(), providerGatewayPlugin(), pdfjsLocalAssets()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, './src'),
        }
      }
    };
});
