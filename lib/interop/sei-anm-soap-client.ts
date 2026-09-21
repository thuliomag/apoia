/**
 * RASCUNHO / PONTO DE PARTIDA — Cliente SOAP para o Web Service nativo do SEI (ANM)
 * ---------------------------------------------------------------------------------
 * Contexto: `lib/interop/sei.ts` (InteropSEI, já existente no repositório da Apoia/TRF2)
 * espera que `SEI_API_URL` aponte para uma API REST JSON (módulo "sei-rest-api-module")
 * que o TRF2 construiu por cima do próprio SEI. Esse módulo NÃO está nos repositórios
 * públicos de trf2-jus-br (verificado em 2026-09-21) — é provável que seja um módulo
 * interno da instalação SEI do TRF2, ou algo que precisaríamos pedir formalmente a eles.
 *
 * O SEI "de fábrica" (o mesmo software que a ANM já usa — SEI-ANM) não expõe REST,
 * e sim um Web Service SOAP de interoperabilidade (mesmo princípio do MNI da Justiça,
 * mas protocolo próprio do projeto SEI). Este arquivo é o ponto de partida para um
 * adaptador que fala SOAP diretamente com o SEI-ANM e devolve exatamente o mesmo
 * formato `SeiInput` que `lib/interop/sei-mapping.ts` já sabe converter — ou seja,
 * a ideia é NÃO reescrever a lógica de mapeamento/agregação da Apoia, só trocar a
 * origem dos dados.
 *
 * STATUS: esqueleto não testado. As operações e nomes de parâmetros abaixo (SiglaSistema,
 * IdentificacaoServico, IdUnidade, consultarProcedimento, consultarDocumento) seguem o
 * padrão documentado publicamente do Web Service do SEI (ex.: pacote R "rsei", proxies
 * de terceiros como sei-soap-proxy-app), mas PRECISAM ser confirmados contra:
 *   1) o Manual de Web Services do SEI na versão instalada na ANM, e
 *   2) o WSDL real publicado pelo SEI-ANM (normalmente algo como
 *      https://sei.anm.gov.br/sei/controlador_ws.php?servico=sei&wsdl — o path exato
 *      varia por instalação e precisa ser confirmado com a equipe de TI/SEI da ANM).
 *
 * PRÉ-REQUISITO ADMINISTRATIVO (fora do código): a ANM precisa cadastrar a Apoia como
 * "Sistema Externo" no painel de administração do SEI-ANM (Administração > Sistemas),
 * o que gera a `SiglaSistema` e a `IdentificacaoServico` (senha de serviço) usadas
 * abaixo. Isso é feito por um administrador do SEI, não por código.
 */

import * as soap from 'soap' // dependência a adicionar: npm install soap
import { SeiInput, SeiAndamento, SeiDocumento } from './sei-mapping'
import { envString, envStringPrefixed } from '../utils/env'

export type SeiAnmSoapConfig = {
    wsdlUrl: string           // ex.: SEI_ANM_WSDL_URL
    siglaSistema: string      // ex.: SEI_ANM_SIGLA_SISTEMA
    identificacaoServico: string // ex.: SEI_ANM_IDENTIFICACAO_SERVICO (segredo)
    idUnidade: string         // unidade SEI em nome da qual a consulta é feita
}

export function getSeiAnmSoapConfig(seqOrgao?: string): SeiAnmSoapConfig {
    return {
        wsdlUrl: envStringPrefixed('SEI_ANM_WSDL_URL', seqOrgao),
        siglaSistema: envStringPrefixed('SEI_ANM_SIGLA_SISTEMA', seqOrgao),
        identificacaoServico: envStringPrefixed('SEI_ANM_IDENTIFICACAO_SERVICO', seqOrgao),
        idUnidade: envStringPrefixed('SEI_ANM_ID_UNIDADE', seqOrgao),
    }
}

const clientCache = new Map<string, soap.Client>()

async function getSoapClient(wsdlUrl: string): Promise<soap.Client> {
    const cached = clientCache.get(wsdlUrl)
    if (cached) return cached
    const client = await soap.createClientAsync(wsdlUrl)
    clientCache.set(wsdlUrl, client)
    return client
}

/**
 * O Web Service do SEI retorna datas/horas no formato "AAAAMMDDHHMMSS" (14 dígitos,
 * sem separadores — confirmado no Manual de Web Services do projeto SEI, mesmo padrão
 * usado nos parâmetros DataInicio/DataFim das operações de consulta). Convertemos para
 * ISO 8601 para que `new Date(data.dataGeracao)` (lib/interop/sei.ts) e a correlação
 * documento→andamento por dataHora (lib/interop/sei-mapping.ts, que compara strings
 * ISO) funcionem como o resto da Apoia espera.
 */
function parseSeiDataHora(seiDataHora: string | undefined): string | undefined {
    if (!seiDataHora) return undefined
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(seiDataHora)
    if (!m) return seiDataHora // formato inesperado: repassa como veio, para não mascarar o dado real
    const [, ano, mes, dia, hora, minuto, segundo] = m
    return `${ano}-${mes}-${dia}T${hora}:${minuto}:${segundo}`
}

/**
 * Consulta um procedimento (processo) no SEI-ANM via SOAP e monta o objeto `SeiInput`
 * que `mapSeiToSimplified` (lib/interop/sei-mapping.ts) já sabe converter para o
 * formato interno da Apoia.
 *
 * TODO (confirmar contra o WSDL real do SEI-ANM antes de usar em produção):
 *  - Nome exato da operação principal — nos exemplos públicos analisados aparece como
 *    variações de "consultarProcedimento"/"consultarProcedimentoIndividual"; a operação
 *    "cheia" (que devolve andamentos + documentos de uma vez, análoga ao que
 *    `InteropSEI.consultarProcesso` espera) precisa ser confirmada — pode ser necessário
 *    combinar 2 chamadas (uma para metadados/andamentos, outra por documento).
 *  - Mapeamento de cada campo do retorno SOAP (em XML/objeto aninhado) para os campos
 *    de `SeiAndamento`/`SeiDocumento` abaixo — feito de forma ilustrativa, não validada.
 *  - Paginação/streaming para processos com muitos documentos.
 *
 * Já tratado (validado com o formato documentado publicamente pelo SEI, não contra
 * uma instância real): datas/horas retornadas como "AAAAMMDDHHMMSS" são convertidas
 * para ISO 8601 por `parseSeiDataHora()`, para casar com o que `sei-mapping.ts` espera.
 */
export async function consultarProcedimentoNoSeiAnm(
    numeroProcesso: string,
    config: SeiAnmSoapConfig
): Promise<SeiInput> {
    const client = await getSoapClient(config.wsdlUrl)

    const baseParams = {
        SiglaSistema: config.siglaSistema,
        IdentificacaoServico: config.identificacaoServico,
        IdUnidade: config.idUnidade,
    }

    // --- 1) Metadados + andamentos do procedimento -----------------------------------
    // TODO: confirmar nome da operação e parâmetros (ex.: ProtocoloProcedimento,
    // SinRetornarAndamentoGeracao, SinRetornarAndamentoConclusao, SinRetornarUltimoAndamento,
    // SinRetornarUnidadesProcedimentoAberto, SinRetornarAssuntos, SinRetornarInteressados,
    // SinRetornarObservacoes, SinRetornarAndamentos, SinRetornarDocumentos).
    const [procedimentoResp] = await client.consultarProcedimentoAsync({
        ...baseParams,
        ProtocoloProcedimento: numeroProcesso,
        SinRetornarAndamentos: 'S',
        SinRetornarDocumentos: 'S',
        SinRetornarAssuntos: 'S',
        SinRetornarInteressados: 'S',
    })

    const procedimento = procedimentoResp?.return

    if (!procedimento) {
        throw new Error(`SEI-ANM: procedimento ${numeroProcesso} não encontrado ou sem permissão de acesso`)
    }

    // --- 2) Normalização para o shape `SeiInput` --------------------------------------
    // Os nomes de campo abaixo (à direita do `??`) são hipóteses baseadas no padrão
    // observado em integrações SEI públicas; validar contra a resposta real.
    const andamentos: SeiAndamento[] = (procedimento.Andamentos?.Andamento || procedimento.andamentos || []).map((a: any) => ({
        sequencia: Number(a.Sequencia ?? a.sequencia),
        dataHora: parseSeiDataHora(a.DataHora ?? a.dataHora),
        descricao: a.Descricao ?? a.descricao,
        idTarefa: a.IdTarefa ? Number(a.IdTarefa) : undefined,
    }))

    const documentos: SeiDocumento[] = (procedimento.Documentos?.Documento || procedimento.documentos || []).map((d: any) => ({
        sequencia: Number(d.Sequencia ?? d.sequencia),
        numero: d.ProtocoloDocumento ?? d.numero,
        protocoloFormatado: d.ProtocoloDocumentoFormatado,
        idDocumento: d.IdDocumento ?? d.idDocumento,
        tipo: d.Serie?.Nome ?? d.tipo ?? '',
        nome: d.Descricao ?? d.nome ?? '',
        nivelSigilo: d.NivelAcesso ?? d.nivelSigilo ?? '0',
        mimeType: d.Mime ?? d.mimeType ?? 'application/octet-stream',
        nomeArquivo: d.Nome ?? d.nomeArquivo ?? '',
        dataHora: parseSeiDataHora(d.DataHora ?? d.dataHora),
    }))

    const seiInput: SeiInput = {
        numero: numeroProcesso,
        protocoloFormatado: procedimento.ProtocoloProcedimentoFormatado,
        nivelSigilo: procedimento.NivelAcesso ?? '0',
        tipoProcedimento: {
            id: Number(procedimento.TipoProcedimento?.Id ?? 0),
            nome: procedimento.TipoProcedimento?.Nome ?? '',
        },
        dataGeracao: parseSeiDataHora(procedimento.DataAutuacao ?? procedimento.DataGeracao),
        orgao: {
            sigla: procedimento.UnidadeAtual?.Sigla ?? '',
            nome: procedimento.UnidadeAtual?.Descricao ?? '',
        },
        interessados: (procedimento.Interessados?.Interessado || []).map((i: any) => ({
            nome: i.Nome,
            polo: undefined, // SEI não modela polo ativo/passivo (é conceito judicial); manter vazio
            tipoPessoa: i.Sigla ? undefined : 'FISICA',
        })),
        andamentos,
        documentos,
    }

    return seiInput
}

/**
 * Obtém o binário de um documento do SEI-ANM via SOAP.
 * TODO: confirmar operação real (ex.: variação de "consultarDocumento" retornando
 * o conteúdo em base64) e ajustar decodificação.
 */
export async function obterDocumentoBinarioSeiAnm(
    idDocumento: string,
    config: SeiAnmSoapConfig
): Promise<{ buffer: ArrayBuffer, contentType: string }> {
    const client = await getSoapClient(config.wsdlUrl)
    const [resp] = await client.consultarDocumentoAsync({
        SiglaSistema: config.siglaSistema,
        IdentificacaoServico: config.identificacaoServico,
        IdUnidade: config.idUnidade,
        ProtocoloDocumento: idDocumento,
        SinRetornarCampos: 'S',
    })
    const doc = resp?.return
    const base64 = doc?.Conteudo // TODO: confirmar campo real do conteúdo binário
    if (!base64) {
        throw new Error(`SEI-ANM: não foi possível obter o binário do documento ${idDocumento}`)
    }
    const buffer = Buffer.from(base64, 'base64')
    return { buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), contentType: doc?.Mime ?? 'application/octet-stream' }
}
