# RSS GOV.BR (sites governamentais)

![gov.br](https://img.shields.io/badge/gov.br-Plone-FFDF00?labelColor=009C3B)
![JavaScript](https://img.shields.io/badge/JavaScript-ES%20Modules-F7DF1E?logo=javascript&logoColor=white)
![XML](https://img.shields.io/badge/XML-1.0-005FAD?logo=xml&logoColor=white)
![RSS](https://img.shields.io/badge/RSS-2.0-FFA500?logo=rss&logoColor=white)

![Node.js](https://img.shields.io/badge/Node.js-18%2B-1351B4?logo=nodedotjs&logoColor=white)
![Deno](https://img.shields.io/badge/Deno-suportado-000000?logo=deno&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-suportado-FBF0DF?logo=bun&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![AWS Lambda](https://img.shields.io/badge/AWS-Lambda-FF9900?logo=awslambda&logoColor=white)

Converte as páginas de notícias dos portais **gov.br** (ministérios, institutos, agências) em feeds **RSS 2.0**, com título, link, data, resumo, categoria e **foto** de cada notícia.

Sem dependências. Roda em Node 18+, Deno, Bun e Cloudflare Workers: como linha de comando, como servidor HTTP ou como biblioteca.

```bash
node bin/cli.js https://www.gov.br/inpe/pt-br/assuntos/ultimas-noticias > inpe.xml
```

## Por quê

Infelizmente os portais do governo brasileiro GOV.BR até têm feeds próprios (`…/RSS`, `…/rss.xml`), mas:

- segue a **ordem da pasta**, não a data de publicação;
- em muitos órgãos está **parado há anos**, sem atualização;
- não traz imagens.

Este projeto lê a própria página HTML da listagem (a mesma que um visitante vê) e gera o feed a partir dela.

## O que ele entende

| Modelo de página | Como é lido |
|---|---|
| "Notícias com foto" (Plone 4/5) | `<ul class="noticias">` com um `<li>` por notícia |
| "Tiles" (Plone 4/5) | `<article class="tileItem">` por notícia |
| Plone 6 / Volto | a lista não vem no HTML; usa a API REST do Plone (`++api++/…/@search`), ordenada por data de publicação |

Exemplos de páginas testadas:

- INPE https://www.gov.br/inpe/pt-br/assuntos/ultimas-noticias
- Ministério da Cultura https://www.gov.br/cultura/pt-br/assuntos/noticias
- Ministério da Ciência, Tecnologia e Inovação https://www.gov.br/mcti/pt-br/acompanhe-o-mcti/noticias/
- Agência Espacial Brasileira https://www.gov.br/aeb/pt-br/assuntos/noticias

## Imagens

- A miniatura da listagem é trocada pela escala `large` do Plone (~768px).
- Notícias que vêm **sem foto** na listagem: o script abre a página da notícia e pega a primeira imagem do texto (o `og:image` desses portais é sempre o logo do órgão, então é ignorado). São no máximo 15 páginas por geração (configurável), as mais recentes primeiro. Com cache, o resultado (inclusive "sem foto") fica guardado por 7 dias, e as fotos que faltarem aparecem nas gerações seguintes.
- No feed, a imagem sai em `<enclosure>` e em `<media:content>` (Media RSS), o que cobre a maioria dos leitores.

## Uso

### Linha de comando

```bash
node bin/cli.js <url>               # RSS no stdout
node bin/cli.js --json <url>        # itens em JSON
node bin/cli.js --sem-fotos <url>   # não abre as páginas das notícias (mais rápido)
```

Junto com um cron, já dá pra servir o feed como arquivo estático:

```cron
*/30 * * * * node /opt/rss-gov-br/bin/cli.js https://www.gov.br/inpe/pt-br/assuntos/ultimas-noticias > /var/www/feeds/inpe.xml
```

### Servidor HTTP (Node)

```bash
PORT=8080 npm start
```

```
http://localhost:8080/rss/govbr?url=<página de notícias do gov.br>
```

Variáveis de ambiente: `PORT` (padrão `8080`) e `CAMINHO` (padrão `/rss/govbr`). O feed fica em cache na memória por 30 minutos.

| Status | Quando |
|---|---|
| 200 | feed gerado (`application/rss+xml`) |
| 400 | `url` ausente ou fora do gov.br |
| 422 | a página foi lida, mas nenhuma notícia foi reconhecida |
| 502 | erro ao baixar a página (HTTP, timeout, redirect para fora do gov.br) |

### Cloudflare Workers, Deno, Bun

O handler de [src/handler.js](src/handler.js) recebe um `Request` e devolve um `Response` (Fetch API padrão), então funciona direto nessas plataformas.

```js
// Deno
import { criarHandler } from "./src/handler.js";
Deno.serve(criarHandler());
```

```js
// Bun
import { criarHandler } from "./src/handler.js";
Bun.serve({ fetch: criarHandler() });
```

Para Workers, veja [examples/cloudflare-worker.js](examples/cloudflare-worker.js), que usa a Cache API do Cloudflare.

### AWS Lambda

O adaptador [examples/aws-lambda.js](examples/aws-lambda.js) converte o evento da Lambda em `Request` e usa o mesmo handler. Com uma **Function URL**, a AWS dá um endereço público para a função, sem precisar de API Gateway.

1. No console da AWS, abra **Lambda → Create function** e escolha o runtime **Node.js 20.x** (ou mais novo).
2. Gere o pacote e envie em **Code → Upload from → .zip file**:
   ```bash
   zip -r funcao.zip package.json src examples/aws-lambda.js
   ```
3. Em **Runtime settings**, defina o handler como `examples/aws-lambda.handler`.
4. Em **Configuration → General configuration**, aumente o **Timeout** para 30 s. O padrão de 3 s é curto, porque o script abre até 15 páginas de notícia.
5. Em **Configuration → Function URL**, crie a URL com **Auth type: NONE**.

O feed fica em:

```
https://<id>.lambda-url.<região>.on.aws/?url=<página de notícias do gov.br>
```

O plano gratuito da Lambda inclui 1 milhão de requisições por mês. O cache em memória só vale enquanto a instância está ativa; para um cache que dure mais, coloque o CloudFront na frente da Function URL.

### Biblioteca

```js
import { converterGovBr } from "./src/govbr-rss.js";

const { xml, titulo, itens } = await converterGovBr("https://www.gov.br/aeb/pt-br/assuntos/noticias");
```

Cada item é `{ titulo, link, resumo, imagem, data, categoria }`, com `data` como `Date` ou `null`.

Opções (todas opcionais):

| Opção | Padrão | |
|---|---|---|
| `fotos` | `true` | abrir as páginas das notícias sem foto |
| `fotosPorPedido` | `15` | máximo de páginas abertas por chamada |
| `maxItens` | `60` | máximo de notícias no feed |
| `timeoutMs` | `15000` | timeout de cada requisição |
| `userAgent` | `rss-gov-br/1.0` | |
| `cache` | nenhum | objeto `{ get(chave), set(chave, valor, segundos) }`, síncrono ou assíncrono |
| `fetch` | `globalThis.fetch` | para injetar proxy, mock em testes etc. |
| `self` | nenhum | endereço público do feed, para o `<atom:link rel="self">` |
| `descricao` | `Notícias de <url>` | `<description>` do canal |

`criarCacheMemoria()` devolve um cache simples em memória. Qualquer outro (Redis, arquivo, KV) serve desde que tenha `get` e `set`.

As partes também são exportadas separadamente: `lerPaginaGovBr`, `lerListagemGovBr(html, url)`, `lerApiPlone(json)`, `completarFotos`, `gerarRss`, `imagemDaNoticiaGovBr`, `urlGovBr`.

## Exemplo de saída

```xml
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>Notícias — Agência Espacial Brasileira</title>
  <link>https://www.gov.br/aeb/pt-br/assuntos/noticias</link>
  <language>pt-br</language>
  <item>
    <title>AEB coorganiza 5ª Conferência South America Water from Space</title>
    <link>https://www.gov.br/aeb/pt-br/assuntos/noticias/aeb-coorganiza-5a-conferencia-…</link>
    <guid isPermaLink="true">…</guid>
    <pubDate>Wed, 11 Nov 2026 10:42:00 GMT</pubDate>
    <description>Evento aborda, entre outros assuntos, a contribuição de satélites…</description>
    <enclosure url="…/conferencia-foto-em-grupo.jpeg/@@images/image/large" type="image/jpeg" length="0"/>
    <media:content url="…/conferencia-foto-em-grupo.jpeg/@@images/image/large" medium="image"/>
  </item>
</channel>
</rss>
```

## Segurança

Não é um proxy aberto: só aceita endereços `https://` em `gov.br` ou `*.gov.br`, sem usuário, senha ou porta, e recusa redirects que saiam do gov.br.

## Limites

- Datas no formato `dd/mm/aaaa` (com ou sem hora) são lidas no horário de Brasília; sem hora, vale meio-dia.
- O parser usa expressões regulares: se um portal mudar o HTML, ele pode parar de reconhecer as notícias (resposta 422).
- O cache em memória vive só enquanto o processo vive. Em serverless, use um cache externo.

## Licença

[MIT](LICENSE) © 2026 Cadu Rolim

