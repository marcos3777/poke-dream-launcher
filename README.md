# PokeDream Launcher

Navegador multitela leve (Electron) para [PokeDream](https://pokedream.com.br/). Abre ate **4 telas simultaneas** em grade 2x2, com modo foco (zoom em uma tela) e sessoes persistentes.

## Funcionalidades

- 4 telas em grade 2x2 carregando pokedream.com.br
- Clique em uma tela para dar **zoom** (tela cheia)
- Botao **Grade** para voltar ao grid 2x2
- **Sessoes salvas** -- cookies e storage persistem ao fechar/reabrir
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

## Estrutura

```
main.js       - processo principal (janelas, layout, IPC)
app.html      - painel lateral (sidebar) e barra superior
preload.js    - ponte IPC entre UI e main process
```

## Dados salvos

Sessoes e logins ficam em `%APPDATA%/poke-dream-launcher/storage/`.
