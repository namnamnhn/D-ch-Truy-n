import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
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
                if (id.includes('node_modules/@google/genai')) {
                  return 'vendor-genai';
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
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, './src'),
        }
      }
    };
});
