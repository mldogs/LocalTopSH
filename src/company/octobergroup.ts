import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CONFIG } from '../config.js';
import { BOT_PROFILE } from '../profile.js';

const COMPANY_ID = 'octobergroup';

const SOURCE_URLS = [
  'https://octobergroup.ru/',
  'https://octobergroup.ru/en',
];

const UPDATE_EVERY_MS = 7 * 24 * 60 * 60 * 1000; // weekly
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // every 6h

const MAX_PROMPT_CHARS = 3500;
const MAX_INTERNAL_PROMPT_CHARS = 8000;

const DEFAULT_INTERNAL_CONTEXT = `# October Group: проекты (внутренняя справка)

Дата составления: 2026-02-06
Составитель: внутренний ассистент October Group
Статус: черновик. Перед использованием в внешних материалах сверять с отделом маркетинга/проектными командами.

## Кратко
- Stories (Раменки) - основной публичный проект на текущий момент.
- King & Sons (Раменки) - проект в сегменте премиум (детали уточнять у РП/маркетинга).
- K-CITY (ЦАО) - коммерческий проект (БЦ класса A, публичных деталей мало).

## Как помогать
- Если нужны данные по конкретной перспективной площадке для ТЗ/презентации: попроси уточнить, о какой площадке идет речь, и приложить внутренние материалы в чат. Если материалов нет, подскажи обратиться к руководителю проекта/РП.
`;

function contextDir(workspaceRoot: string) {
  return join(workspaceRoot, '_shared', 'company');
}

export function getOctoberGroupContextPath(workspaceRoot: string): string {
  return join(contextDir(workspaceRoot), `${COMPANY_ID}.md`);
}

export function getOctoberGroupInternalContextPath(workspaceRoot: string): string {
  return join(contextDir(workspaceRoot), `${COMPANY_ID}_internal.md`);
}

function ensureDir(path: string) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&mdash;/g, '-')
    .replace(/&ndash;/g, '-');
}

function stripTags(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, '$1')
    .replace(/<[^>]+>/g, '');
}

function cleanHtmlText(text: string): string {
  const decoded = decodeHtmlEntities(text);
  const stripped = stripTags(decoded);
  return stripped
    .replace(/[ \t\r]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstMatch(html: string, pattern: RegExp): string | undefined {
  const match = html.match(pattern);
  if (!match?.[1]) return undefined;
  return cleanHtmlText(match[1]);
}

function extractJsonLdOrganization(html: string): any | undefined {
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRegex)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const type = (item?.['@type'] || '').toString();
        const name = (item?.name || '').toString();
        if (type.toLowerCase() === 'organization' && /october/i.test(name)) {
          return item;
        }
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function stripScriptsAndStyles(html: string): string {
  // Remove inline styles/scripts to prevent accidental regex matches on CSS/JS blobs.
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OctoberGroupBot/1.0)' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function buildMarkdownSnapshot(data: {
  updatedAt: string;
  mission?: string;
  focus?: string;
  values?: string;
  experienceSqm?: string;
  foundersYears?: string;
  projectStories?: { tagline?: string; description?: string; url?: string };
  salesOfficeAddress?: string;
  phone?: string;
  social?: string[];
  org?: { name?: string; description?: string; address?: string; telephone?: string };
}): string {
  const lines: string[] = [];

  lines.push('# October Group');
  lines.push(`Обновлено: ${data.updatedAt}`);
  lines.push('Источники:');
  for (const url of SOURCE_URLS) lines.push(`- ${url}`);
  lines.push('');

  if (data.mission) {
    lines.push('## Миссия');
    lines.push(data.mission);
    lines.push('');
  }

  if (data.focus) {
    lines.push('## Фокус');
    lines.push(data.focus);
    lines.push('');
  }

  if (data.values) {
    lines.push('## Ценности');
    lines.push(data.values);
    lines.push('');
  }

  if (data.experienceSqm || data.foundersYears) {
    lines.push('## Опыт');
    if (data.experienceSqm) lines.push(`- Реализовано: ${data.experienceSqm}`);
    if (data.foundersYears) lines.push(`- Опыт учредителей: ${data.foundersYears}`);
    lines.push('');
  }

  if (data.projectStories?.tagline || data.projectStories?.description) {
    lines.push('## Проект: Stories');
    if (data.projectStories.url) lines.push(`- Сайт: ${data.projectStories.url}`);
    if (data.projectStories.tagline) lines.push(`- Тэглайн: ${data.projectStories.tagline}`);
    if (data.projectStories.description) lines.push(data.projectStories.description);
    lines.push('');
  }

  const contactAddress = data.salesOfficeAddress || data.org?.address;
  const contactPhone = data.phone || data.org?.telephone;
  if (contactAddress || contactPhone) {
    lines.push('## Контакты (публичные)');
    if (contactAddress) lines.push(`- Адрес: ${contactAddress}`);
    if (contactPhone) lines.push(`- Телефон: ${contactPhone}`);
    lines.push('');
  }

  if (data.social?.length) {
    lines.push('## Соцсети');
    for (const s of data.social) lines.push(`- ${s}`);
    lines.push('');
  }

  if (data.org?.description) {
    lines.push('## Описание (с сайта)');
    lines.push(data.org.description);
    lines.push('');
  }

  // Minimal internal guidance (safe, non-sensitive)
  lines.push('## Примечание для сотрудников');
  lines.push('Политики и конфиденциальные детали уточняйте во внутренних источниках (HR/IT/PM). Этот файл собран из публичных материалов и может отставать от актуального состояния.');
  lines.push('');

  return lines.join('\n');
}

export function loadOctoberGroupContext(workspaceRoot: string): { text: string; stale: boolean; path: string } {
  const path = getOctoberGroupContextPath(workspaceRoot);

  try {
    if (!existsSync(path)) {
      return { text: '', stale: true, path };
    }
    const stats = statSync(path);
    const tooLarge = stats.size > 20_000; // heuristic: context should stay compact
    const text = readFileSync(path, 'utf-8');
    const needsMigration = !text.includes('https://octobergroup.ru/') || !text.includes('Источники:');
    const stale = tooLarge || needsMigration || (Date.now() - stats.mtimeMs > UPDATE_EVERY_MS);
    return { text, stale, path };
  } catch {
    return { text: '', stale: true, path };
  }
}

export function getOctoberGroupContextForPrompt(workspaceRoot: string): string {
  const { text } = loadOctoberGroupContext(workspaceRoot);
  if (!text.trim()) return '(справка о компании пока не сформирована)';
  if (text.length <= MAX_PROMPT_CHARS) return text;
  return text.slice(0, MAX_PROMPT_CHARS) + '\n\n...(сокращено)...\n';
}

export function loadOctoberGroupInternalContext(workspaceRoot: string): { text: string; path: string } {
  const path = getOctoberGroupInternalContextPath(workspaceRoot);
  try {
    if (!existsSync(path)) {
      return { text: '', path };
    }
    const text = readFileSync(path, 'utf-8');
    return { text, path };
  } catch {
    return { text: '', path };
  }
}

export function ensureOctoberGroupInternalContext(workspaceRoot: string) {
  try {
    ensureDir(contextDir(workspaceRoot));
    const path = getOctoberGroupInternalContextPath(workspaceRoot);
    if (!existsSync(path)) {
      writeFileSync(path, DEFAULT_INTERNAL_CONTEXT, 'utf-8');
      console.log(`[company] October Group internal context created: ${path}`);
    }
  } catch (e: any) {
    console.log(`[company] Failed to ensure October Group internal context: ${e?.message || e}`);
  }
}

export function getOctoberGroupInternalContextForPrompt(workspaceRoot: string): string {
  const { text } = loadOctoberGroupInternalContext(workspaceRoot);
  if (!text.trim()) return '(внутренних заметок пока нет)';
  if (text.length <= MAX_INTERNAL_PROMPT_CHARS) return text;
  return text.slice(0, MAX_INTERNAL_PROMPT_CHARS) + '\n\n...(сокращено)...\n';
}

export async function refreshOctoberGroupContext(workspaceRoot: string): Promise<{ ok: boolean; error?: string }> {
  try {
    ensureDir(contextDir(workspaceRoot));

    const rawHtml = await fetchText(SOURCE_URLS[0], CONFIG.timeouts.webFetch);

    // Extract structured org data before stripping scripts/styles.
    const org = extractJsonLdOrganization(rawHtml);
    const html = stripScriptsAndStyles(rawHtml);
    const orgDescription = typeof org?.description === 'string' ? cleanHtmlText(org.description) : undefined;
    const orgTelephone = typeof org?.telephone === 'string' ? cleanHtmlText(org.telephone) : undefined;
    const orgAddress =
      typeof org?.address?.streetAddress === 'string'
        ? cleanHtmlText(org.address.streetAddress)
        : undefined;
    const orgSocial = Array.isArray(org?.sameAs)
      ? org.sameAs.map((s: any) => (typeof s === 'string' ? s : '')).filter(Boolean)
      : undefined;

    const mission = firstMatch(
      html,
      /IndexConcept-desc[\s\S]*?<p[^>]*class=["'][^"']*IndentText[^"']*["'][^>]*>([\s\S]*?)<\/p>/i
    );
    const focus = firstMatch(
      html,
      /<p[^>]*class=["'][^"']*IndexConcept-focus__text[^"']*["'][^>]*>([\s\S]*?)<\/p>/i
    );
    const values = firstMatch(
      html,
      /<p[^>]*class=["'][^"']*IndexConcept-values__text[^"']*["'][^>]*>([\s\S]*?)<\/p>/i
    );

    const numbers = Array.from(
      html.matchAll(
        /<p[^>]*class=["'][^"']*IndexAbout__big-number[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi
      )
    )
      .map(m => cleanHtmlText(m[1] || ''))
      .filter(Boolean);
    const experienceSqm = numbers.find(n => n.includes('000') || n.includes('million')) || numbers[0];
    const foundersYears = numbers.find(n => n.includes('+') && !n.includes('000')) || numbers[1];

    const salesOfficeAddress = firstMatch(
      html,
      /<p[^>]*class=["'][^"']*offices-switcher-item__address[^"']*["'][^>]*>([\s\S]*?)<\/p>/i
    );
    const phone = firstMatch(html, /href=["']tel:[^"']+["'][^>]*>(\+7[^<]+)<\/a>/i);

    const storiesTagline = firstMatch(
      html,
      /<h4[^>]*class=["'][^"']*ProjectCard__sub-title[^"']*["'][^>]*>([\s\S]*?)<\/h4>/i
    );
    const storiesDesc = firstMatch(
      html,
      /<p[^>]*class=["'][^"']*ProjectCard__text[^"']*["'][^>]*>([\s\S]*?)<\/p>/i
    );

    const snapshot = buildMarkdownSnapshot({
      updatedAt: new Date().toISOString(),
      mission,
      focus,
      values,
      experienceSqm,
      foundersYears,
      projectStories: {
        url: 'https://storiesmoscow.ru/',
        tagline: storiesTagline,
        description: storiesDesc,
      },
      salesOfficeAddress,
      phone,
      social: orgSocial,
      org: {
        name: typeof org?.name === 'string' ? cleanHtmlText(org.name) : undefined,
        description: orgDescription,
        address: orgAddress,
        telephone: orgTelephone,
      },
    });

    const path = getOctoberGroupContextPath(workspaceRoot);
    writeFileSync(path, snapshot, 'utf-8');
    console.log(`[company] October Group context updated: ${path}`);
    return { ok: true };
  } catch (e: any) {
    console.log(`[company] Failed to refresh October Group context: ${e?.message || e}`);
    return { ok: false, error: e?.message || String(e) };
  }
}

async function refreshIfStale(workspaceRoot: string) {
  const { stale } = loadOctoberGroupContext(workspaceRoot);
  if (!stale) return;
  await refreshOctoberGroupContext(workspaceRoot);
}

export function startOctoberGroupContextUpdater(workspaceRoot: string) {
  if (BOT_PROFILE === 'lab') {
    return;
  }

  // Create internal notes file if missing (best-effort).
  ensureOctoberGroupInternalContext(workspaceRoot);

  // Best-effort: never block bot startup.
  void refreshIfStale(workspaceRoot);

  setInterval(() => {
    void refreshIfStale(workspaceRoot);
  }, CHECK_EVERY_MS);
}
