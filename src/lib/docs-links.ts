export type Doc = {
  file: string;
  language: 'zh' | 'en';
  topic: string;
  slug: string[];
  url: string;
  title: string;
  content: string;
  category: 'guides' | 'developers' | 'api';
};

export function resolveDocLink(file: string, href: string, docs: Pick<Doc, 'file' | 'url'>[]): string {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/i.test(href)) return href;
  const [, pathname, suffix] = /^([^?#]*)(.*)$/.exec(href)!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return href;
  }
  if (decoded.startsWith('/') || decoded.includes('\\')) return href;
  const segments = file.split('/').slice(0, -1);
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return href;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const target = segments.join('/');
  const doc = docs.find((candidate) => candidate.file === target);
  return doc ? `${doc.url}${suffix}` : `https://github.com/asharca/ToolPlane/blob/main/${segments.map(encodeURIComponent).join('/')}${suffix}`;
}
