import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const PATCH_MARKER = 'dsh-server-kit-deepseek-brand-v1'
const AUTH_GATE_VERSION = '0.12.0'

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function replaceOnce(source, search, replacement, label) {
  const index = source.indexOf(search)
  if (index === -1) throw new Error(`Auth Gate login page no longer has the expected ${label}; update the branding patch before upgrading`)
  return `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`
}

const themeDeclaration = [
  'const DSH_SERVER_KIT_THEME_STYLE = `',
  `  /* ${PATCH_MARKER}: visual overrides only; authentication flow remains upstream. */`,
  '  :root { color-scheme: light dark; --dshk-bg: #f7f8fa; --dshk-surface: #fff; --dshk-label: #1f2329; --dshk-secondary: #6b7280; --dshk-border: rgba(0, 0, 0, .1); --dshk-input: #fff; --dshk-primary: #4176e6; --dshk-primary-hover: #567ffe; --dshk-ring: rgb(65 118 230 / 18%); --dshk-error: #b42318; --dshk-error-bg: #fff5f4; --dshk-error-border: #fecdc9; }',
  '  body { background: var(--dshk-bg); color: var(--dshk-label); }',
  '  .card { width: 380px; padding: 38px 32px 32px; border: .5px solid var(--dshk-border); border-radius: 18px; background: var(--dshk-surface); box-shadow: 0 12px 32px rgb(15 23 42 / 7%); }',
  '  .brand { width: auto; height: auto; margin: 0 auto 24px; border-radius: 0; background: transparent; color: var(--dshk-label); gap: 7px; font-size: 20px; font-weight: 650; letter-spacing: -.025em; }',
  '  .brand img { width: 32px; height: 32px; display: block; }',
  '  .brand-suffix { color: var(--dshk-secondary); font-weight: 500; }',
  '  h1 { color: var(--dshk-label); font-weight: 600; letter-spacing: -.02em; }',
  '  .subtitle, .label, footer, footer a { color: var(--dshk-secondary); }',
  '  input { border-color: var(--dshk-border); color: var(--dshk-label); background: var(--dshk-input); }',
  '  input:focus { border-color: var(--dshk-primary); box-shadow: 0 0 0 3px var(--dshk-ring); }',
  '  input::placeholder { color: #9aa0aa; }',
  '  .eye { color: var(--dshk-secondary); }',
  '  .eye:hover { background: rgb(0 0 0 / 4%); }',
  '  button[type=submit] { background: var(--dshk-primary); }',
  '  button[type=submit]:hover { background: var(--dshk-primary-hover); }',
  '  .error { color: var(--dshk-error); background: var(--dshk-error-bg); border-color: var(--dshk-error-border); }',
  '  @media (prefers-color-scheme: dark) {',
  '    :root { --dshk-bg: #17171a; --dshk-surface: #202024; --dshk-label: #f4f4f5; --dshk-secondary: #a1a1aa; --dshk-border: rgba(255, 255, 255, .12); --dshk-input: #27272c; --dshk-primary: #567ffe; --dshk-primary-hover: #6b90ff; --dshk-ring: rgb(103 158 254 / 24%); --dshk-error: #fecaca; --dshk-error-bg: rgb(127 29 29 / 35%); --dshk-error-border: rgb(248 113 113 / 36%); }',
  '    .card { box-shadow: 0 18px 38px rgb(0 0 0 / 24%); }',
  '    input::placeholder { color: #71717a; }',
  '    .eye:hover { background: rgb(255 255 255 / 6%); }',
  '  }',
  '  @media (max-width: 420px) { .card { padding: 32px 24px 26px; } }',
  '`;',
].join('\n')

const profileArgument = option('--profile')
if (!profileArgument) throw new Error('usage: brand-auth-gate-login.mjs --profile <directory>')

const profileDir = resolve(profileArgument)
const packageDir = join(profileDir, 'node_modules', 'dsh-auth-gate')
const packagePath = join(packageDir, 'package.json')
const loginPagePath = join(packageDir, 'lib', 'shared', 'login-page.js')
const authPackage = JSON.parse(await readFile(packagePath, 'utf8'))
if (authPackage.name !== 'dsh-auth-gate' || authPackage.version !== AUTH_GATE_VERSION) {
  throw new Error(`expected dsh-auth-gate@${AUTH_GATE_VERSION} before applying the branded login page`)
}

let source = await readFile(loginPagePath, 'utf8')
if (source.includes(PATCH_MARKER)) {
  process.stdout.write('Auth Gate login page branding already applied\n')
  process.exit(0)
}

source = replaceOnce(source, 'const SHIELD_SVG =', `${themeDeclaration}\nconst SHIELD_SVG =`, 'login page style declaration')
source = replaceOnce(source, '<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="viewport" content="width=device-width, initial-scale=1">\n<link rel="icon" type="image/svg+xml" href="/favicon.svg">', 'viewport metadata')
source = replaceOnce(source, '<title>${options.title}</title>', '<title>${options.title} — DeepSeek Harness</title>', 'document title')
source = replaceOnce(source, '<style>${CARD_STYLE}</style>', '<style>${CARD_STYLE}${DSH_SERVER_KIT_THEME_STYLE}</style>', 'style injection point')
source = replaceOnce(source, '<div class="brand">${SHIELD_SVG}</div>', '<div class="brand" aria-label="DeepSeek Harness"><img src="/favicon.svg" width="32" height="32" alt=""><span>DeepSeek</span><span class="brand-suffix">Harness</span></div>', 'brand mark')
source = source.replace(/\n\/\/# sourceMappingURL=login-page\.js\.map\n?$/, '\n')

await writeFile(loginPagePath, source)
process.stdout.write('Auth Gate login page branding applied\n')
