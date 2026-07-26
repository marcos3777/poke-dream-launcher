# PokeDream Launcher

Navegador multitela leve (Electron) para [PokeDream](https://pokedream.com.br/). Abre ate **4 telas simultaneas** em grade 2x2, com modo foco (zoom em uma tela) e sessoes persistentes.

## Funcionalidades

- 4 telas em grade 2x2 carregando pokedream.com.br
- Clique em uma tela para dar **zoom** (tela cheia)
- Botao **Grade** para voltar ao grid 2x2
- **Sessoes salvas e criptografadas** -- cookies e storage persistem ao fechar/reabrir; o backup do storage e cifrado com `safeStorage` do SO (nao fica em texto puro no disco)
- Recarregar telas individualmente (botaozinho ↻)
- Janela sem moldura com barra arrastavel

---

## 📖 Tutorial passo a passo (pra quem NAO programa)

Nao precisa saber nada de programacao. E so seguir na ordem. **Voce so faz os passos 1 e 2 uma unica vez.** (Instrucoes para **Windows**.)

### Passo 1 — Instalar o Node.js (uma vez so)

O Node.js e o "motor" que faz o launcher rodar. Instala igual qualquer programa:

1. Entre em **https://nodejs.org**
2. Clique no botao verde da esquerda que diz **LTS** (a versao recomendada).
3. Abra o arquivo que baixou e clique **Next / Avancar** ate o fim, depois **Finish**. Pode deixar tudo no padrao.

### Passo 2 — Baixar o launcher (uma vez so)

1. No topo desta pagina do GitHub, clique no botao verde **`< > Code`**.
2. Clique em **Download ZIP**.
3. Ache o arquivo `.zip` na sua pasta de Downloads, clique com o **botao direito → Extrair tudo**.
4. Vai virar uma pasta chamada `poke-dream-launcher` (ou `poke-dream-launcher-master`). **Guarde ela num lugar fixo** (ex.: Documentos), porque e daqui que o launcher roda.

### Passo 3 — Abrir a "linha de comando" dentro da pasta

1. Abra a pasta que voce extraiu (a que tem os arquivos `main.js`, `app.html`, etc.).
2. Clique na **barra de endereco** do Explorer (aquela em cima que mostra o caminho da pasta).
3. Apague o que estiver escrito, digite **`cmd`** e aperte **Enter**.
4. Vai abrir uma janela preta (o "Prompt de Comando") **ja dentro da pasta certa**. E nela que voce cola os comandos abaixo.

### Passo 4 — Preparar (uma vez so)

Na janela preta, cole a linha abaixo e aperte **Enter**. Ela baixa o que o launcher precisa (demora 1-2 minutos na primeira vez; espere terminar).

```bash
npm install
```

### Passo 5 — Abrir o launcher

Cole esta linha e aperte **Enter**:

```bash
npm start
```

Pronto! O launcher abre. Clique em **`+ Adicionar tela`** e faca login no PokeDream normalmente. Repita o `+ Adicionar tela` para abrir ate 4 contas ao mesmo tempo.

### Da proxima vez que quiser abrir

Voce **nao** repete os passos 1, 2 e 4. E so:

1. Abrir a pasta do launcher;
2. Digitar `cmd` na barra de endereco (Passo 3);
3. Colar `npm start` e apertar Enter.

> 💡 **Dica:** cansou de digitar? Veja a secao **Gerar instalador** mais abaixo — da pra transformar em um programa normal, com atalho no Desktop, que abre com dois cliques (sem janela preta).

### Deu algum problema?

- **"npm nao e reconhecido como comando"** → o Node.js nao terminou de instalar ou o terminal foi aberto antes. Feche a janela preta, reinicie o computador e tente o Passo 3 de novo.
- **Uma tela ficou branca / travada** → passe o mouse na tela na lista lateral e clique no **↻** para recarregar so ela.
- **Sumiu o login** → normal na primeira vez; depois de logar uma vez, ele fica salvo para as proximas.

---

## Como rodar (resumo, pra quem ja manja)

```bash
npm install
npm start
```

Ou direto: `npx electron .`

## Gerar instalador

Isso cria um programa instalavel (com atalho no Desktop), para nao precisar mais do terminal:

```bash
# Windows (.exe, instalador)
npm run dist

# Linux (.AppImage)
npm run dist:linux
```

O arquivo final fica na pasta `dist/`. No Windows, e so abrir o `.exe` gerado e instalar como qualquer programa. (Como o executavel nao tem assinatura digital paga, o Windows pode mostrar um aviso na primeira vez: **Mais informacoes → Executar assim mesmo**.)

## Estrutura

```
main.js       - processo principal (janelas, layout, IPC, persistencia)
app.html      - painel lateral (sidebar) e barra superior
preload.js    - ponte IPC entre UI e main process
```

## Privacidade e dados salvos

Sessoes e logins ficam **somente no seu computador**, em `%APPDATA%/poke-dream-launcher/`:

- `storage/storage-accN.bin` -- backup do localStorage/sessionStorage de cada tela, **criptografado** com `safeStorage` (DPAPI no Windows / Keychain no macOS / libsecret no Linux). Como pode conter o token de login, nunca compartilhe esses arquivos.
- Cookies de sessao sao convertidos em persistentes (~60 dias) para manter o login entre execucoes.

O login e persistido de forma **orientada a eventos** (reage a navegacao/redirect do login), e o backup do storage so e regravado quando algo muda.

## Licenca

MIT. Projeto comunitario, sem vinculo oficial com o PokeDream.
