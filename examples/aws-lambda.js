// AWS Lambda (Node.js 20+) com Function URL.
// Handler na configuração da função: examples/aws-lambda.handler
//
// O endereço fica: https://<id>.lambda-url.<região>.on.aws/?url=<página de notícias do gov.br>
// O cache em memória vale enquanto a instância da Lambda estiver ativa (alguns minutos sem uso).

import { criarHandler } from "../src/handler.js";

const app = criarHandler({ caminho: "/" });

export async function handler(evento) {
	const query = evento.rawQueryString ? `?${evento.rawQueryString}` : "";
	const url = `https://${evento.headers?.host || "localhost"}${evento.rawPath || "/"}${query}`;
	const resp = await app(new Request(url, { method: evento.requestContext?.http?.method || "GET" }));
	return {
		statusCode: resp.status,
		headers: Object.fromEntries(resp.headers),
		body: await resp.text(),
	};
}
