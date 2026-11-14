#!/usr/bin/env node
// Linha de comando: imprime o RSS no stdout (bom para cron + arquivo estático).
//   node bin/cli.js https://www.gov.br/inpe/pt-br/assuntos/ultimas-noticias > inpe.xml
//   node bin/cli.js --json <url>      itens em JSON
//   node bin/cli.js --sem-fotos <url> não abre as páginas das notícias

import { converterGovBr } from "../src/govbr-rss.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const fotos = !args.includes("--sem-fotos");
const url = args.find((a) => !a.startsWith("--"));

if (!url) {
	console.error("Uso: rss-gov-br [--json] [--sem-fotos] <página de notícias do gov.br>");
	process.exit(2);
}

try {
	const r = await converterGovBr(url, { fotos });
	if (!r.itens.length) {
		console.error(`Nenhuma notícia reconhecida em ${url}`);
		process.exit(1);
	}
	process.stdout.write(json ? JSON.stringify({ titulo: r.titulo, itens: r.itens }, null, 2) + "\n" : r.xml);
} catch (e) {
	console.error(`Erro: ${e.message}`);
	process.exit(1);
}
