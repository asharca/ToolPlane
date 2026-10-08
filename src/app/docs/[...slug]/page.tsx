import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { DocsPage, DocsTitle, DocsDescription, DocsBody } from 'fumadocs-ui/layouts/docs/page';
import { getDocs } from '@/lib/docs';
import { DocumentContent } from '../document-content';

const copy = {
  zh: {
    title: 'ToolPlane 文档',
    description: '使用指南、开发者文档与 API 参考。',
    intro: '从使用指南开始，了解部署与集成；开发者文档介绍架构、运行时和维护流程。API 文档提供接口与协议说明。',
    categories: {
      guides: { title: '用户文档', description: '部署、配置和使用 ToolPlane。' },
      developers: { title: '开发者文档', description: '了解架构、运行时、开发与维护流程。' },
      api: { title: 'API 文档', description: '在独立接口站查看端点、请求示例与交互式参考。' },
    },
    reference: '打开独立交互式 API 参考（英文）',
  },
  en: {
    title: 'ToolPlane Documentation',
    description: 'User guides, developer documentation and API reference.',
    intro: 'Start with the guides for deployment and integration, explore the architecture and runtimes in the developer documentation, or browse the API and protocol reference.',
    categories: {
      guides: { title: 'User guides', description: 'Deploy, configure and use ToolPlane.' },
      developers: { title: 'Developer documentation', description: 'Explore architecture, runtimes, development and maintenance.' },
      api: { title: 'API documentation', description: 'Open the separate reference site for endpoints, examples and interactive requests.' },
    },
    reference: 'Open the standalone interactive API reference',
  },
} as const;

export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }): Promise<Metadata> {
  const { slug } = await params;
  const language = slug[0] === 'en' ? 'en' : 'zh';
  const text = copy[language];
  const doc = (await getDocs()).find(doc => doc.slug.join('/') === slug.join('/'));
  const category = text.categories[slug[1] as keyof typeof text.categories];
  const title = doc?.title ?? (slug.join('/') === 'en/api/reference' ? text.reference : category?.title);
  return { title: title ? `${title} | ${text.title}` : text.title, description: category?.description ?? text.description };
}

export default async function DocumentPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const docs = await getDocs();
  const [language, category] = slug;
  if (language !== 'zh' && language !== 'en') {
    if (slug.length === 1 && ['guides', 'developers'].includes(language)) redirect(`/docs/zh/${language}`);
    const legacy = docs.find(doc => [doc.category, ...doc.file.slice(0, -3).split('/')].join('/') === slug.join('/'));
    if (legacy) redirect(legacy.url);
    notFound();
  }

  const text = copy[language];
  if (slug.length === 1) {
    return <DocsPage full>
      <DocsTitle>{text.title}</DocsTitle>
      <DocsDescription>{text.description}</DocsDescription>
      <DocsBody>
        <p>{text.intro}</p>
        <div className="grid gap-6 lg:grid-cols-3">
          {Object.entries(text.categories).map(([key, entry]) => <Link key={key} href={key === 'api' ? '/docs-api' : `/docs/${language}/${key}`} className="block rounded-xl border p-6 no-underline hover:bg-fd-accent">
            <h2 className="mt-0">{entry.title}</h2>
            <p className="mb-0">{entry.description}</p>
          </Link>)}
        </div>
      </DocsBody>
    </DocsPage>;
  }

  if (slug.join('/') === 'en/api/reference') redirect('/docs-api');

  if (slug.length === 2 && Object.hasOwn(text.categories, category)) {
    const entry = text.categories[category as keyof typeof text.categories];
    return <DocsPage full>
      <DocsTitle>{entry.title}</DocsTitle>
      <DocsDescription>{entry.description}</DocsDescription>
      <DocsBody>
        {category === 'api' ? <p><Link href="/docs-api" hrefLang="en">{text.reference}</Link></p> : null}
        {category === 'developers' ? <p><Link href={`/docs/${language}/api`}>{language === 'zh' ? 'API 与协议接入指南' : 'API and protocol integration guides'}</Link></p> : null}
        <ul>{docs.filter(doc => doc.language === language && doc.category === category && doc.topic !== 'docs/README').map(doc => <li key={doc.file}><Link href={doc.url}>{doc.title}</Link></li>)}</ul>
      </DocsBody>
    </DocsPage>;
  }

  const doc = docs.find(doc => doc.slug.join('/') === slug.join('/'));
  if (!doc) notFound();
  if (doc.topic === 'docs/README') redirect(`/docs/${doc.language}`);
  // Translation navigation belongs to the site shell, not the Markdown body.
  const content = doc.content.replace(/^(\s*# [^\r\n]+\r?\n\s*)>[^\r\n]*(?:English|中文|Chinese)[^\r\n]*\]\([^\r\n]+\.md(?:#[^\r\n)]*)?\)[^\r\n]*\r?\n/i, '$1');
  return <DocsPage full>
    <DocsBody><DocumentContent content={content} file={doc.file} links={docs.map(({ file, url }) => ({ file, url }))} /></DocsBody>
  </DocsPage>;
}
