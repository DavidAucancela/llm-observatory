// Resolve/load hooks registered by register.mjs (see there).
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !/^\.{1,2}\//.test(specifier)) throw err;
    return next(`${specifier}.js`, context);
  }
}

export async function load(url, context, next) {
  if (url.startsWith('file:') && url.includes('/src/') && url.endsWith('.js')) {
    return next(url, { ...context, format: 'module' });
  }
  return next(url, context);
}
