import { createReadStream, createWriteStream, readFileSync, statSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { pipeline } from 'stream';
import glob from 'tiny-glob';
import { promisify } from 'util';
import zlib from 'zlib';
import cheerio from 'cheerio';

const pipe = promisify(pipeline);

const info = {
  pages: {},
  css: [],
}

/** @type {import('.')} */
export default function({ pages = 'build', assets = pages, fallback, precompress = false, importPrefix = undefined, meta = {} } = {}) {
  return {
    name: 'sveltekit-adapter-chrome-extension',

    async adapt(builder) {
      
      builder.rimraf(assets);
      builder.rimraf(pages);

      builder.writeStatic(assets);
      builder.writeClient(assets);

      await builder.prerender({
        fallback,
        all: !fallback,
        dest: pages
      });

      if (precompress) {
        if (pages === assets) {
          builder.log.minor('Compressing assets and pages');
          await compress(assets);
        } else {
          builder.log.minor('Compressing assets');
          await compress(assets);

          builder.log.minor('Compressing pages');
          await compress(pages);
        }
      }

      if (pages === assets) {
        builder.log(`Wrote site to "${pages}"`);
      } else {
        builder.log(`Wrote pages to "${pages}" and assets to "${assets}"`);
      }

      /* extension */
      await removeInlineScripts(assets, builder.log.minor);
      if (importPrefix) await addImportPrefix(assets, importPrefix, builder.log.minor);
      meta.importPrefix = importPrefix;
      writeFileSync(join(assets, 'meta.js'), `export const meta = ${JSON.stringify({...meta, ...info}, null, 2)};`);  
    }
  };
}

/**
 * Hash using djb2
 * @param {import('types/hooks').StrictBody} value
 */
function hash(value) {
  let hash = 5381;
  let i = value.length;

  if (typeof value === 'string') {
    while (i) hash = (hash * 33) ^ value.charCodeAt(--i);
  } else {
    while (i) hash = (hash * 33) ^ value[--i];
  }

  return (hash >>> 0).toString(36);
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

async function addImportPrefix(directory, prefix, log) {
  const files = await glob('**/*.{js,css}', {
    cwd: directory,
    dot: true,
    aboslute: true,
    filesOnly: true
  });
  const css = [];

  const pages = files.filter(f => !f.includes('pages.js')).map(f => join(directory, f))
    .map((file) => {
      let js = readFileSync(file).toString();
      for (const fileName of files) {        
        const matches = js.match(new RegExp(`["'][^"']*${escapeRegExp(basename(fileName))}["']`, 'g'));
        const unique = [...new Set(matches||[])];
        unique.forEach(relative => {
          const q=relative[0]; // Quota
          js = js.replace(new RegExp(escapeRegExp(relative), 'g'), `${q}${prefix}${fileName}${q}`);
        })
      }
      if (file.includes('start-')) js = js.replace('"/app/"', '""');
      if (file.includes('.css')) info.css.push(file.replace(`${directory}/`, prefix));

      writeFileSync(file, js);
    });
}

async function removeInlineScripts(directory, log) {
  const files = await glob('**/*.{html}', {
    cwd: directory,
    dot: true,
    aboslute: true,
    filesOnly: true
  });

  const pages = files.map(f => join(directory, f))
    .map((file) => {
      const f = readFileSync(file);
      const $ = cheerio.load(f.toString());
      const node = $('script[type="module"]').get()[0];
      const attribs = Object.keys(node.attribs).reduce((a, c) => a + `${c}="${node.attribs[c]}" `, "");
      const innerScript = node.children[0].data;
      const fullTag = $('script[type="module"]').toString();
      //get new filename
      const fn = `/script-${hash(innerScript)}}.js`;
      //remove from orig html file and replace with new script tag
      const newHtml = f.toString().replace(fullTag, `<script ${attribs} src="${fn}"></script>`);
      writeFileSync(file, newHtml);
      log(`rewrote ${file}`);

      const p = `${directory}${fn}`;
      writeFileSync(p, innerScript);
      log(`wrote ${p}`);
      return {
        page: file.replace(directory, ''),
        selector: `${attribs.trim().split(' ').slice(-1)}`,
        script: fn
      }
    });
  info.pages = pages;  
}
/**
 * @param {string} directory
 */
async function compress(directory) {
  const files = await glob('**/*.{html,js,json,css,svg,xml}', {
    cwd: directory,
    dot: true,
    absolute: true,
    filesOnly: true
  });

  await Promise.all(
    files.map((file) => Promise.all([compress_file(file, 'gz'), compress_file(file, 'br')]))
  );
}

/**
 * @param {string} file
 * @param {'gz' | 'br'} format
 */
async function compress_file(file, format = 'gz') {
  const compress =
    format == 'br'
      ? zlib.createBrotliCompress({
        params: {
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: statSync(file).size
        }
      })
      : zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION });

  const source = createReadStream(file);
  const destination = createWriteStream(`${file}.${format}`);

  await pipe(source, compress, destination);
}
