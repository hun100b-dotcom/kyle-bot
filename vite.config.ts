import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // base './' : Electron 이 화면을 웹 주소가 아니라 "파일(file://)"로 열기 때문에,
  // 자원 경로를 절대(/assets/…)가 아닌 상대(./assets/…)로 만들어야 화면이 뜬다.
  base: './',
})
