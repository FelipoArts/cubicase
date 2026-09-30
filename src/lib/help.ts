// URL do tutorial no site, no idioma da interface: português em /tutorial/,
// inglês em /en/tutorial/. `articleId` é o id do artigo (ex.: "criar-servidor"),
// igual nas duas versões, e vai como âncora (#id).
const SITE = "https://cubicase.net";

export function tutorialUrl(locale: string, articleId?: string): string {
  const base = locale.toLowerCase().startsWith("en") ? `${SITE}/en/tutorial/` : `${SITE}/tutorial/`;
  return articleId ? `${base}#${articleId}` : base;
}
