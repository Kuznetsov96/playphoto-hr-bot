const rules = new Intl.PluralRules("uk");

/** Українські форми числа: one / few / many («1 день, 3 дні, 7 днів»). */
export function ukPlural(n: number, forms: { one: string; few: string; many: string }): string {
    const category = rules.select(n);
    if (category === "one") return forms.one;
    if (category === "few") return forms.few;
    return forms.many;
}

export function ukDays(n: number): string {
    return `${n} ${ukPlural(n, { one: "день", few: "дні", many: "днів" })}`;
}
