// `node --test` setup for the web utils: Vite resolves `import './fmt'`
// without an extension and treats src/*.js as ES modules; plain Node does
// neither, so this hook does both. Keeps the web tests dependency-free.
import { register } from 'node:module';

register('./resolve-hook.mjs', import.meta.url);
