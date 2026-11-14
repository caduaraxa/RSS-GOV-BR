// RSS das listagens de notícias do gov.br (portais Plone de ministérios, institutos e agências).
//
// Os feeds do próprio gov.br (…/RSS, …/rss.xml) seguem a ordem da pasta e não a data, e em muitos
// órgãos estão parados há anos. Aqui a página HTML da listagem vira itens com título, link, data,
// resumo e foto, e sai como RSS 2.0.
//
// Núcleo sem dependência de plataforma: usa só fetch, URL e AbortSignal (Node 18+, Deno, Bun, Workers,
// navegador). Cache é opcional e plugável (ver criarCacheMemoria).
//
// Os portais gov.br têm dois modelos de listagem, e os dois são lidos:
// - "notícias com foto": <ul class="noticias ..."> com <li> por notícia (INPE, Cultura, MCTI)
// - "tiles": <article class="tileItem ..."> por notícia (AEB)
// Portais já migrados para o Plone 6 não têm a lista no HTML: aí a lista vem da API REST do Plone.

export const PADROES = {
	userAgent: "Mozilla/5.0 (compatible; rss-gov-br/1.0; +https://github.com/caduaraxa/RSS-GOV-BR)",
	maxItens: 60,
	fotosPorPedido: 15, // páginas de notícia abertas por geração do feed
	fotoCacheSegundos: 7 * 86400, // a foto de uma notícia não muda
	timeoutMs: 15000,
};

// ---------------------------------------------------------------- texto e datas

const ENTIDADES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", ordm: "º", ordf: "ª", deg: "°" };

function decodificar(s) {
	return String(s ?? "")
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&([a-z]+);/gi, (m, n) => ENTIDADES[n] ?? m);
}

function textoPuro(s) {
	return decodificar(
		String(s ?? "")
			.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
			.replace(/<[^>]+>/g, " ")
	)
		.replace(/\s+/g, " ")
		.trim();
}

// "dd/mm/aaaa" ou "dd/mm/aaaa hh'h'mm", no horário de Brasília (sem hora: meio-dia)
function lerData(texto) {
	const m = String(texto || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D{1,4}(\d{1,2})\s*[h:]\s*(\d{2}))?/);
	if (!m) return null;
	const [, dd, mm, aaaa, hh = "12", mi = "00"] = m;
	const d = new Date(`${aaaa}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T${hh.padStart(2, "0")}:${mi}:00-03:00`);
	return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------- cache

// Cache em memória com validade. Qualquer objeto com get(chave) e set(chave, valor, segundos),
// síncronos ou assíncronos, serve no lugar dele (Redis, arquivo, Cache API, KV...).
export function criarCacheMemoria() {
	const mapa = new Map();
	return {
		get(chave) {
			const e = mapa.get(chave);
			if (!e) return null;
			if (e.expira < Date.now()) {
				mapa.delete(chave);
				return null;
			}
			return e.valor;
		},
		set(chave, valor, segundos) {
			mapa.set(chave, { valor, expira: Date.now() + segundos * 1000 });
		},
	};
}

// ---------------------------------------------------------------- endereços

// Só páginas https do gov.br (não é um proxy aberto)
export function urlGovBr(texto) {
	let u;
	try {
		u = new URL(String(texto || "").trim());
	} catch {
		return null;
	}
	if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
	if (u.hostname !== "gov.br" && !u.hostname.endsWith(".gov.br")) return null;
	u.hash = "";
	return u;
}

// A foto da listagem é miniatura (128px ou "mini"); a escala "large" do Plone tem ~768px
export function fotoGrande(src) {
	return src.replace(/\/@@images\/[^?#]*$/, "/@@images/image/large");
}

function atributo(tag, nome) {
	const m = tag.match(new RegExp(`\\s${nome}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
	return m ? decodificar(m[1] ?? m[2]) : "";
}

function absoluta(href, base) {
	try {
		const u = new URL(href, base);
		return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------- listagem HTML (Plone 4/5)

// Divide o HTML em blocos, um por notícia
function blocos(html) {
	const ini = html.search(/<ul\s+class=["'][^"']*\bnoticias\b/i);
	if (ini >= 0) {
		let fim = html.slice(ini).search(/<ul\s+class=["'][^"']*\b(?:paginacao|listingBar)\b/i);
		fim = fim < 0 ? html.length : ini + fim;
		const trecho = html.slice(ini, fim);
		return trecho.split(/<li\b[^>]*>/i).slice(1);
	}
	const partes = html.split(/<article\b[^>]*\btileItem\b[^>]*>/i);
	if (partes.length > 1) return partes.slice(1).map((p) => p.split(/<\/article>/i)[0]);
	return [];
}

function lerBloco(b, base) {
	// Título: o link dentro do <h2> (h2.titulo ou h2.tileHeadline); senão, o primeiro link com texto
	const h2 = b.match(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i);
	const a = (h2 && h2[1].match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i)) || b.match(/<a\b([^>]*)>([^<]{15,})<\/a>/i);
	if (!a) return null;
	const link = absoluta(atributo(a[1], "href"), base);
	const titulo = textoPuro(a[2]);
	if (!link || titulo.length < 5) return null;

	const img = b.match(/<img\b[^>]*>/i);
	const src = img ? absoluta(atributo(img[0], "src"), base) : "";

	// Resumo: span.description (tiles) ou o texto depois do " - " em span.descricao
	let resumo = "";
	const desc = b.match(/<span\s+class=["']description["'][^>]*>([\s\S]*?)<\/span>/i);
	if (desc) resumo = textoPuro(desc[1]);
	else {
		const d = b.match(/<span\s+class=["']descricao["'][^>]*>([\s\S]*?)(?=<div\b|<\/div>)/i);
		if (d) resumo = textoPuro(d[1].replace(/<span\s+class=["']data["'][^>]*>[\s\S]*?<\/span>/i, "")).replace(/^-\s*/, "");
	}

	// Data: span.data ou a linha "publicado dd/mm/aaaa hh'h'mm" dos tiles
	const dataTxt = (b.match(/class=["']data["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || (b.match(/class=["']documentByLine["'][^>]*>([\s\S]*)/i) || [])[1] || "";
	const data = lerData(textoPuro(dataTxt));

	const categoria = textoPuro(
		(b.match(/class=["'](?:categoria-noticia|subtitulo-noticia|subtitle)["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i) || [])[1] || ""
	);

	return { titulo, link, resumo, imagem: src ? fotoGrande(src) : "", data, categoria };
}

// HTML da listagem -> [{ titulo, link, resumo, imagem, data (Date|null), categoria }]
export function lerListagemGovBr(html, url, maxItens = PADROES.maxItens) {
	const vistos = new Set();
	const itens = [];
	for (const b of blocos(html)) {
		const i = lerBloco(b, url);
		if (!i || vistos.has(i.link)) continue;
		vistos.add(i.link);
		itens.push(i);
		if (itens.length >= maxItens) break;
	}
	return itens;
}

// Foto da página de uma notícia gov.br, para itens que vieram sem foto na listagem.
// O og:image dessas páginas é sempre o logo do órgão (…/logo.png): vale a primeira imagem do texto.
export function imagemDaNoticiaGovBr(html, base) {
	const ini = html.search(/id=["']content-core["']/i);
	const corpo = ini >= 0 ? html.slice(ini) : "";
	for (const tag of corpo.match(/<img\b[^>]*>/gi) || []) {
		const src = absoluta(atributo(tag, "src"), base);
		if (!src || /\.svg(?:$|\?)|\+\+plone\+\+|\/logo|icon|data:/i.test(src)) continue;
		return src.includes("/@@images/") ? fotoGrande(src) : src;
	}
	const og = (html.match(/<meta\b[^>]*og:image["'][^>]*>/i) || [])[0];
	const src = og ? absoluta(atributo(og, "content"), base) : "";
	return src && !/\/logo\.\w+$/i.test(src) ? src : "";
}

// Nome do órgão para o título do feed: "Últimas Notícias — Instituto Nacional de Pesquisas Espaciais"
export function tituloDaPagina(html) {
	return textoPuro((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "") || "Notícias gov.br";
}

// ---------------------------------------------------------------- portais em Plone 6 (Volto)
// Alguns órgãos já migraram para o Plone 6: a página é montada por JavaScript e o HTML não tem a
// lista. Aí vale a API REST do próprio Plone: <raiz do órgão>/++api++/<caminho>/@search, por data de publicação.

// Raiz da API: o window.env.apiPath da página (ex.: https://www.gov.br/<órgão>), senão o primeiro segmento do caminho
export function enderecoApiPlone(html, url, maxItens = PADROES.maxItens) {
	const u = new URL(url);
	let raiz = ((html.match(/"apiPath"\s*:\s*"([^"]+)"/) || [])[1] || "").replace(/\\u002F/gi, "/");
	if (!urlGovBr(raiz)) raiz = `${u.origin}/${u.pathname.split("/")[1]}`;
	const base = new URL(raiz).pathname.replace(/\/$/, "");
	if (!u.pathname.startsWith(base + "/")) return null;
	const resto = u.pathname.slice(base.length).replace(/\/$/, "");
	const q = new URLSearchParams({ portal_type: "News Item", sort_on: "effective", sort_order: "descending", b_size: String(maxItens) });
	for (const campo of ["effective", "description", "image_scales", "image_field"]) q.append("metadata_fields", campo);
	return `${u.origin}${base}/++api++${resto}/@search?${q}`;
}

export function ehPlone6(html) {
	return /content=["']Plone 6/i.test(html) || /window\.__data\s*=/.test(html);
}

// JSON do @search -> mesmos itens da listagem HTML
export function lerApiPlone(dados) {
	return (dados?.items || [])
		.map((i) => {
			const link = urlGovBr(i["@id"])?.href || "";
			const campo = i.image_field || "image";
			const img = i.image_scales?.[campo]?.[0];
			const download = img?.scales?.large?.download || img?.download || "";
			const data = i.effective && !/^1969|^None/.test(i.effective) ? new Date(i.effective) : null;
			return {
				titulo: textoPuro(i.title),
				link,
				resumo: textoPuro(i.description),
				imagem: download && link ? `${link}/${download}` : "",
				data: data && !Number.isNaN(data.getTime()) ? data : null,
				categoria: "",
			};
		})
		.filter((i) => i.link && i.titulo.length >= 5);
}

// ---------------------------------------------------------------- RSS

const xml = (s) =>
	String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

function tipoDaImagem(url) {
	const ext = (url.replace(/\/@@images\/.*$/, "").match(/\.(\w+)$/) || [])[1]?.toLowerCase();
	return { png: "image/png", gif: "image/gif", webp: "image/webp" }[ext] || "image/jpeg";
}

// self (opcional): endereço público do próprio feed, para o <atom:link rel="self">
export function gerarRss({ titulo, link, self, descricao, itens }) {
	const corpo = itens
		.map((i) => {
			const partes = [
				`<title>${xml(i.titulo)}</title>`,
				`<link>${xml(i.link)}</link>`,
				`<guid isPermaLink="true">${xml(i.link)}</guid>`,
			];
			if (i.data) partes.push(`<pubDate>${i.data.toUTCString()}</pubDate>`);
			if (i.categoria) partes.push(`<category>${xml(i.categoria)}</category>`);
			if (i.resumo) partes.push(`<description>${xml(i.resumo)}</description>`);
			if (i.imagem) {
				partes.push(`<enclosure url="${xml(i.imagem)}" type="${tipoDaImagem(i.imagem)}" length="0"/>`);
				partes.push(`<media:content url="${xml(i.imagem)}" medium="image"/>`);
			}
			return `<item>${partes.join("")}</item>`;
		})
		.join("\n");
	const atomSelf = self ? `\n<atom:link href="${xml(self)}" rel="self" type="application/rss+xml"/>` : "";
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
<title>${xml(titulo)}</title>
<link>${xml(link)}</link>
<description>${xml(descricao || `Notícias de ${link}`)}</description>
<language>pt-br</language>${atomSelf}
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${corpo}
</channel>
</rss>
`;
}

// ---------------------------------------------------------------- rede

function opcoes(o = {}) {
	return { ...PADROES, fetch: globalThis.fetch.bind(globalThis), cache: null, ...o };
}

async function baixarGovBr(url, o) {
	const r = await o.fetch(url.href, {
		headers: { "User-Agent": o.userAgent, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
		redirect: "follow",
		signal: AbortSignal.timeout(o.timeoutMs),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	// O redirect não pode levar para fora do gov.br
	if (!urlGovBr(r.url || url.href)) throw new Error("redirecionou para fora do gov.br");
	return r.text();
}

async function itensDaApiPlone(html, url, o) {
	const api = enderecoApiPlone(html, url, o.maxItens);
	if (!api) return [];
	const r = await o.fetch(api, { headers: { "User-Agent": o.userAgent, Accept: "application/json" }, signal: AbortSignal.timeout(o.timeoutMs) });
	if (!r.ok) throw new Error(`API do Plone: HTTP ${r.status}`);
	return lerApiPlone(await r.json());
}

// Baixa a listagem e devolve { titulo, itens }: HTML dos portais Plone 4/5, ou a API nos portais Plone 6
export async function lerPaginaGovBr(endereco, opts) {
	const o = opcoes(opts);
	const url = urlGovBr(endereco);
	if (!url) throw new ErroEndereco(endereco);
	const html = await baixarGovBr(url, o);
	let itens = lerListagemGovBr(html, url.href, o.maxItens);
	if (!itens.length && ehPlone6(html)) itens = await itensDaApiPlone(html, url.href, o);
	return { titulo: tituloDaPagina(html), link: url.href, itens };
}

// Itens sem foto na listagem: abre a página da notícia (no máximo fotosPorPedido por vez, as mais
// recentes primeiro). Com cache, guarda a resposta por fotoCacheSegundos, inclusive "sem foto".
export async function completarFotos(itens, opts) {
	const o = opcoes(opts);
	let abertas = 0;
	await Promise.all(
		itens.map(async (i) => {
			if (i.imagem) return;
			const chave = `govbr-foto:${i.link}`;
			const guardada = o.cache ? await o.cache.get(chave) : null;
			if (guardada != null) {
				i.imagem = guardada;
				return;
			}
			if (abertas >= o.fotosPorPedido || !urlGovBr(i.link)) return;
			abertas++;
			try {
				i.imagem = imagemDaNoticiaGovBr(await baixarGovBr(new URL(i.link), o), i.link);
			} catch {
				return; // erro de rede: tenta de novo na próxima geração
			}
			if (o.cache) await o.cache.set(chave, i.imagem, o.fotoCacheSegundos);
		})
	);
	return itens;
}

export class ErroEndereco extends Error {
	constructor(endereco) {
		super(`endereço fora do gov.br: ${endereco}`);
		this.name = "ErroEndereco";
	}
}

// Tudo de uma vez: endereço da listagem -> { xml, titulo, itens }
// opts: { fetch, cache, userAgent, maxItens, fotosPorPedido, fotoCacheSegundos, timeoutMs, fotos (true), self, descricao }
export async function converterGovBr(endereco, opts = {}) {
	const { titulo, link, itens } = await lerPaginaGovBr(endereco, opts);
	if (opts.fotos !== false) await completarFotos(itens, opts);
	return { titulo, itens, xml: gerarRss({ titulo, link, self: opts.self, descricao: opts.descricao, itens }) };
}
