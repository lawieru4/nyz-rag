-- 文章链接由接口域名下的 /ArticleDetail?id= 改为能知站点页面（article/client.ts 的 ARTICLE_PAGE_URL）。
-- 文档地址按 articleKey 重写；问答记录中保存的引用链接按旧格式改写，文档已删除的引用同样生效。
UPDATE "documents"
SET "url" = 'https://nyz.nenghe.com/article-detail?id=' || "external_id",
	"canonical_url" = 'https://nyz.nenghe.com/article-detail?id=' || "external_id"
WHERE "external_id" ~ '^[A-Za-z0-9_.-]+$'
	AND "url" <> 'https://nyz.nenghe.com/article-detail?id=' || "external_id";--> statement-breakpoint
UPDATE "message_sources"
SET "url" = regexp_replace("url", '^https?://[^/?#]+/ArticleDetail\?id=([^&#]+)$', 'https://nyz.nenghe.com/article-detail?id=\1')
WHERE "url" ~ '^https?://[^/?#]+/ArticleDetail\?id=[^&#]+$';
