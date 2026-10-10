import { createSearchAPI } from "fumadocs-core/search/server";
import { publicDocs } from "../../../../.source/server";

export const dynamic = "force-static";

export const { staticGET: GET } = createSearchAPI("advanced", {
  localeFilter: true,
  indexes: publicDocs
    .filter((doc) => doc.topic !== "docs/README")
    .map((doc) => ({
      id: doc.file,
      title: doc.title,
      url: doc.url,
      locale: doc.language,
      tag: doc.category,
      structuredData: {
        ...doc.structuredData,
        headings: doc.structuredData.headings.map((heading) => ({
          ...heading,
          id: `user-content-${heading.id}`,
        })),
        contents: doc.structuredData.contents.map((content) => ({
          ...content,
          heading: content.heading
            ? `user-content-${content.heading}`
            : undefined,
        })),
      },
    })),
});
