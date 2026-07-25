# PokeDream Launcher

Navegador multitela leve (Electron) para [PokeDream](https://pokedream.com.br/). Abre ate **4 telas simultaneas** em grade 2x2, com modo foco (zoom em uma tela) e sessoes persistentes.

## Funcionalidades

- 4 telas em grade 2x2 carregando pokedream.com.br
- Clique em uma tela para dar **zoom** (tela cheia)
- Botao **Grade** para voltar ao grid 2x2
- **Sessoes salvas e criptografadas** -- cookies e storage persistem ao fechar/reabrir; o backup do storage e cifrado com `safeStorage` do SO (nao fica em texto puro no disco)
- Recarregar telas individualmente (botaozinho ↻)
- Janela sem moldura com barra arrastavel

## Como rodar

```bash
# instalar dependencias
npm install

# iniciar
npm start
```

Ou direto com npx:

```bash
npx electron .
```

## Gerar instalador

```bash
# Windows (.exe, instalador NSIS)
npm run dist

# Linux (.AppImage)
npm run dist:linux
```

Os arquivos finais ficam em `dist/`.

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
