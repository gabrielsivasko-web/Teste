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

Nenhuma funcionalidade foi alterada. Isso é verificado por `tests/equivalence.mjs`, que abre a v10 original
(`tests/reference/Telemetria_ME1_v10.html`) e a versão nova lado a lado no Chromium, aplica as mesmas ações e compara:

- resultados internos da simulação (todos os quadros da animação, telemetria, hora a hora, balanço dos passes) — bit a bit;
- texto visível, tabelas (texto e cor de cada célula), valores dos campos, posição de rolagem e foco;
- estilo computado de **todos** os elementos da página;
- pixels do canvas em vários instantes do laço;
- captura da página inteira;
- memória salva no PC, `.json` exportado e a cópia `.TXT` (que deve abrir "trancada" e funcionando).

Roda 14 cenários roteirizados (sequências, tamanhos, unidades, tabelas, passes, linha travada/liberada, Servant,
plataforma, trechos, janela, memória, importação de formatos antigos, proteção) e 40 configurações aleatórias.

```bash
npm install
npx playwright install chromium
npm test                      # tudo
node tests/equivalence.mjs --only=passes --fuzz=0   # um cenário
```

## Pontos de atenção encontrados na v10 (mantidos como estão)

Comportamentos que parecem não intencionais. Foram **preservados** para não mudar nada no funcionamento; ficam
registrados para decidir depois:

1. **"✕ Excluir" depois de reordenar** — ao mudar a posição de um trecho (ou a entrada de um passe) a lista é
   reordenada, mas os cartões não são redesenhados: o botão Excluir passa a apagar **outro** item. Ex.: com trechos em
   7,6 / 18 / 26,3 / 40 m, mover o 1º para 30 m e clicar no Excluir dele apaga o de 18 m.
2. **Telemetria de dois ciclos misturada** — com espaçamento de entrada curto (E0 ≈ 1,3–2,5 m), a tabela por veículo
   (V1..Vn) junta passos de dois ciclos diferentes (aparecem trechos voltando, ex.: "36,62m → 0,02m") e a aba por
   perfil pode terminar antes dos 40 m. Com o E0 padrão (4,6 m) não acontece.
3. **Unidade de tempo e velocidade da animação** só são gravadas na memória na próxima alteração que dispara o
   salvamento; trocar e fechar a página em seguida perde a escolha.
4. Digitar um valor inválido nos campos de quantidade (ex.: 0) mantém o número digitado na tela, embora o valor usado
   seja o mínimo (1).
5. Com "Trajeto de Entrada" = 0 digitado no campo, a altura automática da janela considera 2 m, enquanto a simulação e
   o desenho usam 0,01 m (só afeta a altura da janela).
6. A senha do download não fica mais em texto puro (agora é comparada por SHA-256), mas é uma barreira de uso casual:
   quem tem o arquivo `.html` consegue ler o código. O selo "Protegido por Criptografia" é visual.
