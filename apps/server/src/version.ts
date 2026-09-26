import pkg from '../package.json' with { type: 'json' };

/** Version of the storyscript-mov package (inlined by the bundler). */
export const APP_VERSION: string = pkg.version;
