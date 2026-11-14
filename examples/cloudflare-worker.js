// Cloudflare Worker: o mesmo handler, com cache na Cache API do Cloudflare (caches.default),
// que é compartilhado entre requisições (o cache em memória vive só enquanto a instância vive).

import { criarHandler } from "../src/handler.js";

// Adapta a Cache API para a interface { get, set } do núcleo
const cacheCloudflare = {
	async get(chave) {
		const r = await caches.default.match(`https://cache.interno/${encodeURIComponent(chave)}`);
		return r ? r.text() : null;
	},
	async set(chave, valor, segundos) {
		await caches.default.put(
			`https://cache.interno/${encodeURIComponent(chave)}`,
			new Response(valor, { headers: { "Cache-Control": `public, max-age=${segundos}` } })
		);
	},
};

// Plano gratuito: no máximo 50 subrequests por requisição, então poucas fotos por geração
const handler = criarHandler({ cache: cacheCloudflare, fotosPorPedido: 15 });

export default {
	fetch: (request) => handler(request),
};
