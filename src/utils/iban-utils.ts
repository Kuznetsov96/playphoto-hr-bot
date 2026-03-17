/**
 * Identifies Ukrainian bank name by IBAN
 */
export function getBankNameByIban(iban?: string | null): string {
    if (!iban) return '—';
    
    // Clean string: remove spaces and dashes
    const cleanIban = iban.toUpperCase().replace(/[\s-]/g, '');
    
    // Ukrainian IBAN format: UA + 2 check digits + 6 digits MFO + ...
    if (!cleanIban.startsWith('UA') || cleanIban.length < 10) return 'Unknown Format';
    
    const mfo = cleanIban.substring(4, 10);
    
    const bankMap: Record<string, string> = {
        '322313': 'PrivatBank (ПриватБанк)',
        '320649': 'Monobank (Universal Bank)',
        '300335': 'Oschadbank (Ощадбанк)',
        '380805': 'Raiffeisen Bank (Райффайзен)',
        '300528': 'OTP Bank (ОТП Банк)',
        '322669': 'PUMB (ПУМБ)',
        '351005': 'Ukrsibbank (Укрсиббанк)',
        '300023': 'Ukrgazbank (Укргазбанк)',
        '328209': 'Sens Bank (Сенс)',
        '300465': 'Ukreximbank (Укрексімбанк)',
        '325365': 'KredoBank (Кредобанк)',
        '333368': 'A-Bank (А-Банк)',
        '305299': 'Tascombank (ТАСкомбанк)',
        '300614': 'Credit Agricole (Креді Агріколь)',
        '313399': 'Pivdennyi (Південний)'
    };
    
    return bankMap[mfo] || `Other Bank (MFO: ${mfo})`;
}
