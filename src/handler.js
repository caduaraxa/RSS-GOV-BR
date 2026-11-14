// Handler HTTP com Request/Response padrão da web (Fetch API).
// Roda igual em Cloudflare Workers, Deno, Bun e Node 18+ (via bin/server.js).
//
//   GET <caminho>?url=https://www.gov.br/inpe/pt-br/assuntos/ultimas-noticias

import { converterGovBr, criarCacheMemoria, urlGovBr } from "./govbr-rss.js";

const resposta = (corpo, status, tipo, extra = {}) =>
	new Response(corpo, { status, headers: { "Content-Type": tipo, "Access-Control-Allow-Origin": "*", ...extra } });

const TEXTO = "text/plain; charset=utf-8";

// opts: { caminho ("/rss/govbr"), cacheSegundos (1800), cache (memória), + opções de converterGovBr }
export function criarHandler(opts = {}) {
	const { caminho = "/rss/govbr", cacheSegundos = 30 * 60 } = opts;
	const cache = opts.cache === undefined ? criarCacheMemoria() : opts.cache;
	const o = { ...opts, cache };

	return async function handler(request) {
		const pedido = new URL(request.url);
		if (pedido.pathname !== caminho) return resposta("Não encontrado\n", 404, TEXTO);
		if (request.method !== "GET" && request.method !== "HEAD") return resposta("Método não permitido\n", 405, TEXTO);

		const alvo = urlGovBr(pedido.searchParams.get("url"));
		if (!alvo) {
			return resposta(
				`Use ${caminho}?url=<página de notícias do gov.br>, por exemplo\n` +
					`${pedido.origin}${caminho}?url=https://www.gov.br/inpe/pt-br/assuntos/ultimas-noticias\n`,
				400,
				TEXTO
			);
		}

		const self = `${pedido.origin}${caminho}?url=${encodeURIComponent(alvo.href)}`;
		const cabecalhos = { "Cache-Control": `public, max-age=${cacheSegundos}` };
		const chave = `govbr-feed:${alvo.href}`;
		const corpo = (xml) => (request.method === "HEAD" ? null : xml);

		const guardado = cache ? await cache.get(chave) : null;
		if (guardado != null) return resposta(corpo(guardado), 200, "application/rss+xml; charset=utf-8", cabecalhos);

		let r;
		try {
			r = await converterGovBr(alvo.href, { ...o, self });
		} catch (e) {
			return resposta(`Não consegui ler ${alvo.href}: ${e.message}\n`, 502, TEXTO, { "Cache-Control": "no-store" });
		}
		if (!r.itens.length) {
			return resposta(`Nenhuma notícia reconhecida em ${alvo.href}\n`, 422, TEXTO, { "Cache-Control": "no-store" });
		}
		if (cache) await cache.set(chave, r.xml, cacheSegundos);
		return resposta(corpo(r.xml), 200, "application/rss+xml; charset=utf-8", cabecalhos);
	};
}
