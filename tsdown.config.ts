import { defineConfig } from 'tsdown'

const ID = 'dsh-web-scroll-flow'

/** 浏览器模块表（platform modules）中可 require 的共享运行时依赖。 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
]

/** Node 半由 Host profile 提供的服务 / 库依赖，保持 external。 */
const NODE_EXTERNALS = [
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/schemastery',
]

/**
 * Node half: a host-side no-op entry the Loader imports so the row qualifies
 * as a loader entry (the client-modules scan keys off Loader entries).
 * Client half: the browser bundle served from /plugins/<id>/client.js.
 */
export default defineConfig([
  {
    name: ID,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    clean: false,
    sourcemap: true,
    dts: true,
    deps: {
      neverBundle: NODE_EXTERNALS,
    },
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    clean: false,
    sourcemap: true,
    deps: {
      neverBundle: CLIENT_EXTERNALS,
      alwaysBundle: id => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
