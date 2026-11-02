export class Money{
    
    //variaveis
    private readonly cents: bigint;
    private readonly currency: string;

    //construtor privado
    private constructor(cents: bigint, currency: string){
        this.cents = cents;
        this.currency =  currency;
    }


    public getCents(): bigint {
    return this.cents;
    }

    public getCurrency(): string {
    return this.currency;
    }


    //metodo para transformar bigint em string novamente
    public getAmount(): string {
    const reais = (this.cents / 100n).toString();
    const centavos = (this.cents % 100n).toString().padStart(2, '0');//padStart le o resto, se o resto deu 5 apenas, ele coloca um 0 antes
    return `${reais}.${centavos}`;
    }


    public static from(amount: string, currency: string): Money {
    // 1. Segurança do valor: exige dígitos positivos, um ponto e exatamente 2 casas decimais (ex: "100.50")
    if (!/^\d+\.\d{2}$/.test(amount)) {
      throw new Error(`Invalid money amount: "${amount}". Expected format "0.00".`);
    }

    // 2. Segurança da moeda: exige exatamente 3 letras maiúsculas (ex: "BRL", "USD")
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error(`Invalid currency: "${currency}". Expected 3 uppercase letters.`);
    }

    // 3. Tira o ponto ("100.50" vira "10050") e converte para inteiro bigint (10050n)
    const cleanCents = amount.replace('.', '');
    const cents = BigInt(cleanCents);
    // 4. Chama o construtor privado lá dentro e devolve o objeto pronto!
    return new Money(cents, currency);
  }


  //garantir mesma moeda: Operações entre moedas diferentes lançam erro
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(`Currency mismatch: cannot operate on ${this.currency} and ${other.currency}.`);
    }
  }

  //Soma: retorna uma NOVA instância de Money (imutável)
  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  //Subtração: garante que não fica negativo e retorna uma NOVA instância de Money
  public subtract(other: Money): Money {
    this.assertSameCurrency(other);

    if (this.cents < other.cents) {
      throw new Error('Cannot subtract to a negative money amount.');
    }

    return new Money(this.cents - other.cents, this.currency);
  }


  // Retorna true se o valor atual (this) for maior ou igual ao outro (other)
  public isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other); //confere a mesma moeda            
    return this.cents >= other.cents; //retorna verdadeiro ou falso
  }

  // Retorna true se os dois objetos Money tiverem a mesma moeda e os mesmos centavos
  public equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

}