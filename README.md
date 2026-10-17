# Telemetria ME1

Simulador de fluxo da linha XDF / X62 — trechos dinâmicos, passes de operação, plataforma móvel e Servant.
Autor: **Gabriel Ivasko**.

O aplicativo é **um único arquivo**: [`Telemetria_ME1.html`](Telemetria_ME1.html). Basta abrir no navegador
(Chrome/Edge); não precisa de internet nem de instalação. Os parâmetros ficam salvos no próprio PC e podem ser
exportados/importados em `.json` — o formato do arquivo é o mesmo da v10, então arquivos antigos continuam abrindo.

## Arquitetura

O código foi reorganizado em camadas, cada uma com uma responsabilidade:

| # | Camada | O que faz |
|---|--------|-----------|
| 1 | Constantes e enumerações | Fim da linha (40 m), passo de simulação, horizonte de 8 h, fases da plataforma (`PlatPhase`), estados da Servant (`ServPhase`), condições do carro (`CarCond`). Nenhum "número mágico" solto no código. |
| 2 | Configuração e esquema dos campos | `createDefaultConfig()` define os valores de fábrica; `FIELDS` descreve cada slider (rótulo, limites, passo, unidade, cor). Os painéis são gerados a partir desse esquema. |
| 3 | Estado | Separado em `config` (o que é salvo/exportado), `ui` (abas, painéis abertos, seleção da tabela) e `playback` (tempo da animação). |
| 4 | Utilitários | Formatação (`Fmt`), helpers de DOM, SHA-256 da senha. |
| 5 | Sequência e geometria | Padrão de carros, tamanhos L2/L3/L4, trilho lateral da plataforma (uma única função usada pela simulação e pelo desenho), layout da vista de cima. |
| 6 | **Motor de simulação** | `simulate(config)` — não toca no DOM. Atores como classes: `Car`, `Platform`, `Servant` (máquina de estados explícita) e `TelemetryRecorder`. |
| 7 | Pós-processamento | Telemetria compactada, produção hora a hora, balanço por passe. |
| 8 | Interface | Ciclo `recompute()` (simula → atualiza tabelas/badges → salva), componente `createRangeField`, painéis, tabelas. |
| 9 | Canvas | `Renderer` dividido em etapas (grade, trilhos, passes, cotas, plataformas, Servant, carros, etiquetas) e `Player` (laço da animação). |
| 10 | Persistência | Serialização, migração de formatos antigos (`mergeConfig`), memória do PC, exportar/importar. |
| 11 | Ações e inicialização | Botões com `data-action` e um único ouvinte de cliques (sem `onclick` no HTML), proteção do download e `boot()`. |

Fluxo de dados: **ação do usuário → altera `config` → `recompute()` → `simulate()` → resultados → tabelas, badges e
canvas**. O CSS usa variáveis de tema e classes utilitárias (nenhum `style="..."` no HTML).

## Equivalência com a v10

Fora as correções listadas abaixo, nenhuma funcionalidade foi alterada. Isso é verificado por
`tests/equivalence.mjs`, que abre a v10 original (`tests/reference/Telemetria_ME1_v10.html`, com as mesmas correções
aplicadas como remendos mínimos) e a versão nova lado a lado no Chromium, aplica as mesmas ações e compara:

- resultados internos da simulação (todos os quadros da animação, telemetria, hora a hora, balanço dos passes) — bit a bit;
- texto visível, tabelas (texto e cor de cada célula), valores dos campos, posição de rolagem e foco;
- estilo computado de **todos** os elementos da página;
- pixels do canvas em vários instantes do laço;
- captura da página inteira;
- memória salva no PC, `.json` exportado e a cópia `.TXT` (que deve abrir "trancada" e funcionando).

Roda 14 cenários roteirizados (sequências, tamanhos, unidades, tabelas, passes, linha travada/liberada, Servant,
plataforma, trechos, janela, memória, importação de formatos antigos, proteção) e 40 configurações aleatórias. Cada
bug corrigido tem ainda um teste próprio, que precisa reproduzir o bug na v10 original e passar na versão nova.

```bash
npm install
npx playwright install chromium
npm test                      # tudo
node tests/equivalence.mjs --only=passes --fuzz=0   # um cenário
```

## Bugs da v10 corrigidos

1. **"✕ Excluir" depois de reordenar** — ao mudar a posição de um trecho (ou a entrada de um passe), o botão Excluir
   apagava **outro** item. Ex.: com trechos em 7,6 / 18 / 26,3 / 40 m, mover o 1º para 30 m e clicar no Excluir dele
   apagava o de 18 m. Agora o botão apaga sempre o item do próprio cartão.
2. **Telemetria de dois ciclos misturada** — com espaçamento de entrada curto (E0 ≈ 1,3–2,5 m), a tabela por veículo
   (V1..Vn) juntava passos de dois ciclos (trechos "voltando", ex.: "36,62m → 0,02m") e a aba por perfil podia parar
   antes dos 40 m. Agora a telemetria é sempre de um único ciclo, o do fluxo contínuo (o mesmo do balanço dos passes).
   Com o E0 padrão (4,6 m) nada muda.
3. **Unidade de tempo e velocidade da animação** não eram gravadas na memória na hora; trocar e fechar a página em
   seguida perdia a escolha. Agora são salvas imediatamente.
4. **Campos com valor inválido** (ex.: 0 em "Qtd. Sequência", texto em um campo numérico) continuavam mostrando o que
   foi digitado, embora o valor usado fosse outro (o mínimo). Agora mostram o valor efetivamente usado.
5. **"Trajeto de Entrada/Saída" = 0** — a altura automática da janela considerava 2 m / 4 m, enquanto a simulação e o
   desenho usam 0,01 m. Agora as três partes usam o mesmo cálculo do trilho.
6. **Linha tracejada do Ponto 0 da Servant** saía com 5 px em vez de 2 px quando não havia cota de folga desenhada
   (ex.: no instante t = 0). Agora é sempre 2 px.

## Ajustes pedidos depois da refatoração

- **Faixas dos passes** ("XDF Passe 1", …) ficam na frente da plataforma e de tudo mais no desenho da simulação.
- **"Parâmetros Operacionais" e "Passes de Operação"** abrem fechados, como os demais painéis.
- **Espaçamento de Disparo (E0)** é um valor único para todos os carros, como Dmin, Dff e Hmax. Ao abrir uma
  configuração antiga (E0 por carro), vale o E0 do XDF (Atrás de XDF). O `.json` exportado continua trazendo o E0 em
  cada carro, então segue abrindo certo na v10.
- **Seletor do carro em configuração** no lugar dos três botões, e **"⧉ Replicar configuração de"**: copia os trechos
  (posições, velocidades, alturas e paradas) de outro carro para o que está sendo configurado.

## Página Engajamento

O título do cabeçalho é um seletor: **Telemetria ME1** ou **Engajamento**. A página Engajamento mostra um carro
estático, vista de cima, frente à direita, com qualquer especificação cadastrada (XDF/X62 · L2/L3/L4) e um seletor de
passe (1º a 4º). Para cada passe:

- **Postos** — quantos quiser, posicionados livremente (arrastar, duplo clique no desenho ou ➕ Adicionar Posto). As
  posições são medidas a partir da frente do carro e do eixo (lateral + = lado esquerdo, − = lado direito).
- **Planilha de engajamento (.xlsx)** — uma aba por passe (o número no nome da aba indica o passe), 1ª linha de
  cabeçalho, uma linha por FOP. Colunas reconhecidas pelo nome (sem acento/maiúsculas): **FOP**, **Torque** (Nm),
  **Soquete**, **Apertos** e, opcionalmente, **Posto**, **Da frente** e **Lateral**; as demais colunas são guardadas e
  exibidas como vieram. A lista fica em `ENG_SHEET_COLUMNS`, no código. A leitura do .xlsx é feita no próprio arquivo,
  sem bibliotecas nem internet.
- **FOPs na tela** — cada FOP vira uma bolinha com o número dela (➕ Na tela ou ➕ Adicionar todas), arrastada para o
  local da operação no carro; ao passar o mouse aparece o quadro com torque, soquete, nº de apertos, posto e as demais
  colunas.
- **FOPs de cada posto** — cada posto inclui as FOPs que ele faz (na tabela de postos ou pelo seletor "Posto" da
  planilha); a bolinha da FOP fica com a cor do posto. A coluna "Posto" da planilha já faz essa classificação.

Tudo fica salvo no PC e vai junto no `.json` exportado (`engCfg`).

## Página Fluxo de AGVs

Terceira opção do título. Uma área com **grade de 10 m por quadrado**, zoom (roda do mouse, ＋/－, ⤢ Ajustar) e vista
móvel (arrastar o fundo ou ✋ Vista). **O desenho é sempre em escala.**

- **Ferramentas de desenho:** ／ Linha (Shift = ângulos de 15°), ⌒ Curva (arrasta do início ao fim, solta, curva com o
  mouse e clica) e ✎ Lápis (à mão livre; ao soltar, o traço é simplificado e suavizado seguindo o caminho feito).
- **Comprimento dos trechos:** cada traço é um trecho. Selecionado, informa-se o **comprimento (m)** e o desenho se
  ajusta à medida (duas linhas iguais definidas como 5 m e 10 m ficam com 5 m e 10 m). O que está ligado acompanha:
  o lado que se desloca anda inteiro e, num circuito, estica o trecho mais adequado (reto, paralelo ao ajuste e sem
  medida definida) — um retângulo continua retângulo. O "*" marca medida definida; "⚠", medida que outra edição mudou.
- **Ligações e desvios:** começar ou terminar um traço numa ponta (○) continua o trilho; ligar o fim ao começo fecha o
  **circuito**; ligar as pontas de dois trilhos une os dois. Começar ou terminar **no meio de um trecho** (◇) cria um
  **desvio**: o trecho é dividido ali e o traço novo vira um trilho. Trilhos podem só se cruzar, sem ligação.
- **Caminho dos trilhos:** cada trilho tem uma cor e é o caminho que os seus AGVs seguem. Trilhos podem dividir
  trechos: em ✎ Caminho (tabela ou painel do trilho) clica-se nos trechos para acrescentar numa ponta ou tirar da ponta
  — assim um trilho entra num desvio e volta para o circuito. ➕ Novo trilho monta um caminho do zero; ⇄ Inverter
  sentido troca o sentido do trilho. Num trecho dividido, as cores aparecem lado a lado.
- **✥ Mover trilho:** arrastar uma ponta (□) a reposiciona — solta sobre outra ponta ou trecho, liga; arrastar um
  trecho move o trilho inteiro com o que está ligado nele.
- **AGV (0,80 × 1,50 m, comprido no trilho):** clicado sobre um trilho, prende-se a ele e só anda sobre o caminho; a
  ferramenta volta para Selecionar (Shift+clique coloca vários). Clicando nele: velocidade (m/min), sentido (no sentido
  do trilho ou contra), posição inicial, partida (s) e comportamento no fim do trilho (para, vai e volta, recomeça).
  Gira acompanhando o trilho com o eixo no meio do AGV; ao editar a rede, continua no mesmo ponto do seu trecho.
- **Fluxo contínuo:** ▶ Simular anima os AGVs sem reiniciar — cada um segue a sua regra (circuito, vai e volta ou para
  no fim) indefinidamente. O tempo aparece como "Dia N · hh:mm:ss", com **dia de 18 h**; velocidades de 1x a 1800x.
- **Relatório de colisões:** vale só para o **horizonte do relatório (em dias)**. Os AGVs são simulados nesse período
  (passo de 0,1 s; cada par só é testado quando pode se encostar, então vários dias levam poucos segundos) e cada
  contato entre dois AGVs é listado com dia/hora, duração e local; clicar leva ao momento da colisão. No desenho, um
  AGV fica vermelho sempre que encosta em outro, mesmo depois do horizonte.
- ↶ Desfazer / Ctrl+Z, Delete apaga o selecionado, Esc cancela. Tudo fica salvo no PC e no `.json` (`agvCfg`).

No código, `AgvModel` é a rede (nós, trechos, trilhos e as operações de edição, sem DOM) e `AgvFlow` a página.
Arquivos da versão anterior abrem convertidos: o "representa X m" vira o comprimento do desenho.

## Observação sobre a proteção

A senha do download não fica mais em texto puro (agora é comparada por SHA-256), mas é uma barreira de uso casual:
quem tem o arquivo `.html` consegue ler o código. O selo "Protegido por Criptografia" é visual.
