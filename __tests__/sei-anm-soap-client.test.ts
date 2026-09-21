import { describe, expect, test, jest, beforeEach } from '@jest/globals';

// lib/utils/env.ts importa 'server-only'; mock virtual permite importar o
// cliente SOAP (que depende de env.ts) fora do contexto react-server, como
// já é feito em __tests__/sanitize-html.test.ts.
jest.mock('server-only', () => ({}), { virtual: true });

// mapSeiToSimplified (lib/interop/sei-mapping.ts) importa nivelDeSigiloFromNivel
// de lib/interop/pdpj.ts, que arrasta toda a cadeia interop → mni.ts → lib/user.ts
// → app/api/auth/[...nextauth]/options.ts → pacotes ESM-only ("jose", "p-limit")
// não parseáveis pelo transform padrão do ts-jest. Mock direto de pdpj.ts corta a
// cadeia exatamente no ponto usado por sei-mapping.ts, sem depender de nada de auth.
jest.mock('../lib/interop/pdpj', () => ({
    nivelDeSigiloFromNivel: (nivel: string) => {
        const n = Number(nivel);
        return Number.isNaN(n) ? '5' : String(Math.trunc(n));
    },
}));

const consultarProcedimentoAsync = jest.fn();
const consultarDocumentoAsync = jest.fn();

// Mocka o pacote 'soap' inteiro: os testes abaixo validam apenas a lógica de
// mapeamento do cliente (lib/interop/sei-anm-soap-client.ts), não uma conexão
// SOAP real — isso ainda depende do WSDL real do SEI-ANM (ver ADAPTACAO-ANM.md).
jest.mock('soap', () => ({
    createClientAsync: jest.fn(async () => ({
        consultarProcedimentoAsync,
        consultarDocumentoAsync,
    })),
}));

import { consultarProcedimentoNoSeiAnm, obterDocumentoBinarioSeiAnm, SeiAnmSoapConfig } from '../lib/interop/sei-anm-soap-client';
import { mapSeiToSimplified } from '../lib/interop/sei-mapping';

const config: SeiAnmSoapConfig = {
    wsdlUrl: 'https://sei.anm.gov.br/sei/controlador_ws.php?servico=sei&wsdl',
    siglaSistema: 'APOIAANM',
    identificacaoServico: 'segredo-de-teste',
    idUnidade: '110000123',
};

describe('sei-anm-soap-client', () => {
    beforeEach(() => {
        consultarProcedimentoAsync.mockReset();
        consultarDocumentoAsync.mockReset();
    });

    test('converte uma resposta SOAP sintética (formato documentado publicamente do SEI) em SeiInput consumível por mapSeiToSimplified', async () => {
        consultarProcedimentoAsync.mockResolvedValue([{
            return: {
                ProtocoloProcedimentoFormatado: '48000.123456/2026-70',
                NivelAcesso: '0',
                TipoProcedimento: { Id: '110', Nome: 'Pesquisa Mineral' },
                // SEI retorna datas como "AAAAMMDDHHMMSS" (Manual de Web Services do SEI).
                DataAutuacao: '20260921100000',
                UnidadeAtual: { Sigla: 'DIPAR', Descricao: 'Diretoria de Pesquisa Mineral' },
                Interessados: { Interessado: [{ Nome: 'FULANO DE TAL' }] },
                Andamentos: {
                    Andamento: [
                        { Sequencia: '1', DataHora: '20260921100000', Descricao: 'Gerado documento 1234567 por FULANO' },
                        { Sequencia: '2', DataHora: '20260921110000', Descricao: 'Processo remetido para a unidade DIPAR' },
                    ],
                },
                Documentos: {
                    Documento: [{
                        Sequencia: '1',
                        ProtocoloDocumento: '1234567',
                        ProtocoloDocumentoFormatado: '1234567',
                        IdDocumento: '9999',
                        Serie: { Nome: 'Requerimento' },
                        Descricao: 'Requerimento de Pesquisa',
                        NivelAcesso: '0',
                        Mime: 'application/pdf',
                        Nome: 'requerimento.pdf',
                        DataHora: '20260921100000',
                    }],
                },
            },
        }]);

        const seiInput = await consultarProcedimentoNoSeiAnm('48000123456202670', config);

        expect(consultarProcedimentoAsync).toHaveBeenCalledWith(expect.objectContaining({
            SiglaSistema: 'APOIAANM',
            IdentificacaoServico: 'segredo-de-teste',
            IdUnidade: '110000123',
            ProtocoloProcedimento: '48000123456202670',
        }));

        // Datas "AAAAMMDDHHMMSS" convertidas para ISO 8601.
        expect(seiInput.dataGeracao).toBe('2026-09-21T10:00:00');
        expect(seiInput.andamentos[0].dataHora).toBe('2026-09-21T10:00:00');
        expect(seiInput.documentos[0].dataHora).toBe('2026-09-21T10:00:00');

        // O ponto central da integração: o SeiInput produzido pelo cliente SOAP tem
        // que ser aceito por mapSeiToSimplified sem nenhuma alteração nela.
        const [processo] = mapSeiToSimplified(seiInput);
        expect(processo.numeroProcesso).toBe('48000123456202670');
        expect(processo.movimentosEDocumentos).toHaveLength(2);

        // O documento deve casar com o andamento de mesma dataHora cuja descrição
        // cita o número do documento (correlação de sei-mapping.ts).
        const movimentoComDocumento = processo.movimentosEDocumentos.find(m => m.documentos.length > 0);
        expect(movimentoComDocumento?.descricao).toBe('Gerado documento 1234567 por FULANO');
        expect(movimentoComDocumento?.documentos[0].id).toBe('1234567');
    });

    test('lança erro claro quando o procedimento não é encontrado (ou sem permissão)', async () => {
        consultarProcedimentoAsync.mockResolvedValue([{ return: undefined }]);
        await expect(consultarProcedimentoNoSeiAnm('48000123456202670', config)).rejects.toThrow(/não encontrado/);
    });

    test('obterDocumentoBinarioSeiAnm decodifica o conteúdo base64 corretamente', async () => {
        const original = Buffer.from('conteúdo do documento de teste', 'utf-8');
        consultarDocumentoAsync.mockResolvedValue([{
            return: { Conteudo: original.toString('base64'), Mime: 'text/plain' },
        }]);

        const { buffer, contentType } = await obterDocumentoBinarioSeiAnm('1234567', config);

        expect(contentType).toBe('text/plain');
        expect(Buffer.from(buffer).toString('utf-8')).toBe('conteúdo do documento de teste');
    });
});
