import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';

const isProduction = process.env.BUILD === 'production';

export default {
  input: 'src/index.ts',
  output: {
    file: 'dist/index.mjs',
    format: 'es',
    sourcemap: true,
  },
  external: [],
  plugins: [
    resolve({
      preferBuiltins: true,
    }),
    commonjs(),
    typescript({
      tsconfig: 'tsconfig.json',
    }),
    isProduction && terser(),
  ],
};
