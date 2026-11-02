import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/money';

describe('Money', () => {
  it('deve criar Money válido e converter centavos e amount corretamente', () => {
    const money = Money.from('100.50', 'BRL');

    expect(money.getCents()).toBe(10050n);
    expect(money.getCurrency()).toBe('BRL');
    expect(money.getAmount()).toBe('100.50');
  });

  it('deve somar e subtrair mantendo a imutabilidade', () => {
    const saldoInicial = Money.from('100.00', 'BRL');
    const aposta = Money.from('80.00', 'BRL');

    const saldoFinal = saldoInicial.subtract(aposta);

    expect(saldoFinal.getAmount()).toBe('20.00');
    expect(saldoInicial.getAmount()).toBe('100.00');
  });

  it('deve bloquear operações entre moedas diferentes', () => {
    const brl = Money.from('50.00', 'BRL');
    const usd = Money.from('50.00', 'USD');

    expect(() => brl.add(usd)).toThrow();
  });

  it('deve rejeitar entradas inválidas ou subtração negativa', () => {
    expect(() => Money.from('-10.00', 'BRL')).toThrow();
    expect(() => Money.from('10.5', 'BRL')).toThrow();
    expect(() => Money.from('10.555', 'BRL')).toThrow();

    const saldo = Money.from('20.00', 'BRL');
    const apostaMaior = Money.from('50.00', 'BRL');
    expect(() => saldo.subtract(apostaMaior)).toThrow();
  });
});