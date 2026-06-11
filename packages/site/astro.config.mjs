// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://craig.beer',
  vite: {
    plugins: [tailwindcss()],
  },
});
