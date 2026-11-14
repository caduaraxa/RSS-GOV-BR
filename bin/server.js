#!/usr/bin/env node
// Servidor HTTP em Node 18+, sem dependências.
//   PORT=8080 node bin/server.js
//   curl "http://localhost:8080/rss/govbr?url=https://www.gov.br/inpe/pt-br/assuntos/ultimas-noticias"

import http from "node:http";
import { criarHandler } from "../src/handler.js";

const porta = Number(process.env.PORT) || 8080;
const handler = criarHandler({ caminho: process.env.CAMINHO || "/rss/govbr" });

http
	.createServer(async (req, res) => {
		try {
			const origem = `http://${req.headers.host || `localhost:${porta}`}`;
			const resp = await handler(new Request(new URL(req.url, origem), { method: req.method }));
			res.writeHead(resp.status, Object.fromEntries(resp.headers));
			res.end(req.method === "HEAD" ? undefined : Buffer.from(await resp.arrayBuffer()));
		} catch (e) {
			res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
			res.end(`Erro interno: ${e.message}\n`);
		}
	})
	.listen(porta, () => console.log(`rss-gov-br ouvindo em http://localhost:${porta}`));
