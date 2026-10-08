// Deterministic teaching content for the mock provider: probability foundations →
// second-order Markov models. Used for tests, offline development and the
// end-to-end educational evaluation. Written to the same quality bar as live output:
// distractors are specific misconceptions, questions use distinct scenarios, and
// remediation has several genuinely different teaching strategies per concept.
import type { ExplanationContent, QuestionContent, Strategy } from "../../../shared/schemas.ts";
import { slugify } from "../../../shared/slug.ts";

export interface FixtureQuestion extends Omit<QuestionContent, "refs" | "multiSelect"> {
  multiSelect?: boolean;
}

export interface FixtureConcept {
  slug: string;
  name: string;
  definition: string;
  prerequisites: string[]; // slugs
  role: "central" | "background";
  /** Words that locate the concept in a source document's page text. */
  keywords: RegExp;
  explanations: Partial<Record<Strategy, Omit<ExplanationContent, "strategy" | "refs" | "connections"> & { connections?: string[] }>>;
  questions: FixtureQuestion[];
  /** Mock reasoning grader: patterns for sound vs flawed written reasoning. */
  reasoning: { sound: RegExp; flawed: RegExp; misconception: { label: string; description: string } };
}

const opt = (value: string, label: string, misconception?: string) => ({ value, label, ...(misconception ? { misconception } : {}) });

export const CURRICULUM: FixtureConcept[] = [
  {
    slug: "probability",
    name: "Probability",
    definition: "A number between 0 and 1 assigned to an event, measuring what fraction of the (weighted) possible outcomes the event covers; the probabilities of all outcomes of an experiment sum to 1.",
    prerequisites: [],
    role: "background",
    keywords: /\bprobabilit(y|ies) of an event|sample space/i,
    explanations: {
      first_principles: {
        title: "Probability as a share of outcomes",
        body: `Start with the one thing that is always true: **an experiment has a set of possible outcomes, and exactly one of them happens each time.**

A probability is just a way of splitting a total of 1 across those outcomes. An event is a *set* of outcomes ("roll is even" = $\\{2,4,6\\}$), so its probability is the total share of the outcomes it contains:

$$P(E) = \\sum_{\\omega \\in E} P(\\omega)$$

Everything else follows from that picture:
- $P(\\text{everything}) = 1$, because some outcome always happens.
- $P(\\text{not } E) = 1 - P(E)$, because $E$ and "not $E$" split the total between them.
- For "$A$ or $B$" you add the shares, but an outcome in **both** would be counted twice, so subtract the overlap once: $P(A \\cup B) = P(A) + P(B) - P(A \\cap B)$.`,
      },
      worked_example: {
        title: "Probability by counting outcomes",
        body: `Roll a fair die. Each face gets share $\\tfrac16$.

- "Even" $= \\{2,4,6\\}$, three faces → $P = \\tfrac36 = \\tfrac12$.
- "Greater than 4" $= \\{5,6\\}$ → $P = \\tfrac26$.
- "Even **or** greater than 4" $= \\{2,4,5,6\\}$ → $\\tfrac46$. Adding $\\tfrac36 + \\tfrac26 = \\tfrac56$ would count face 6 twice; subtracting the overlap $\\{6\\}$ fixes it: $\\tfrac56 - \\tfrac16 = \\tfrac46$.

The habit to build: **list which outcomes are in the event, then add their shares.**`,
      },
    },
    questions: [
      {
        stem: "A fair six-sided die is rolled once. What is $P(\\text{even or greater than } 4)$?",
        kind: "conceptual", context: "original", scenario: "die even or greater than four",
        options: [opt("2/3", "$\\tfrac{2}{3}$"), opt("5/6", "$\\tfrac{5}{6}$", "adds overlapping events without subtracting the overlap"), opt("1/3", "$\\tfrac{1}{3}$", "counts only outcomes in both events"), opt("1/2", "$\\tfrac{1}{2}$", "ignores the second condition")],
        correct: "2/3",
        explanation: "The event is $\\{2,4,5,6\\}$: four of six equally likely faces, so $\\tfrac46 = \\tfrac23$. $\\tfrac56$ double-counts face 6, which is both even and greater than 4.",
        rubric: { keyIdeas: ["list the outcomes in the event", "the overlap {6} must not be counted twice"], commonFlaws: ["adding 3/6 and 2/6 directly"] },
        difficulty: 1,
      },
      {
        stem: "A spinner lands on red with probability $\\tfrac12$, blue with probability $\\tfrac13$, and green otherwise. What is $P(\\text{not blue})$?",
        kind: "application", context: "original", scenario: "spinner colours complement",
        options: [opt("2/3", "$\\tfrac{2}{3}$"), opt("1/6", "$\\tfrac{1}{6}$", "confuses the complement with a single remaining outcome"), opt("1/3", "$\\tfrac{1}{3}$", "reports the event instead of its complement"), opt("1/2", "$\\tfrac{1}{2}$", "assumes the remaining outcomes are equally likely")],
        correct: "2/3",
        explanation: "Blue and not-blue split the total of 1, so $P(\\text{not blue}) = 1 - \\tfrac13 = \\tfrac23$ (red $\\tfrac12$ plus green $\\tfrac16$).",
        rubric: { keyIdeas: ["complement rule: 1 minus P(blue)", "red and green together"], commonFlaws: ["only counting green"] },
        difficulty: 2,
      },
      {
        stem: "Why must the probabilities of all possible outcomes of one experiment add up to exactly 1?",
        kind: "causal", context: "original", scenario: "why outcomes sum to one",
        options: [opt("exactly-one", "Exactly one outcome occurs on every trial, so together they cover every trial"), opt("percent", "Probabilities are percentages divided by 100, and percentages total 100", "thinks the sum-to-one rule is a unit convention"), opt("equal", "Outcomes are always equally likely, so their shares are equal", "thinks all outcomes must be equally likely"), opt("each-le-1", "Each outcome's probability is at most 1, so the total is at most 1", "confuses a bound on each term with the value of the sum")],
        correct: "exactly-one",
        explanation: "The outcomes are mutually exclusive and exhaustive: on every trial exactly one happens. Their shares therefore partition the whole, which is 1. The percentage story only restates the convention without explaining it.",
        rubric: { keyIdeas: ["outcomes are exhaustive", "outcomes are mutually exclusive"], commonFlaws: ["it's just a convention"] },
        difficulty: 2,
      },
      {
        stem: "A weather service gives a 30% chance of rain and a 10% chance of snow for tomorrow, and it cannot both rain and snow. What is the chance of rain or snow?",
        kind: "application", context: "novel", scenario: "rain or snow forecast",
        options: [opt("40", "40%"), opt("3", "3%", "multiplies probabilities for “or”"), opt("37", "37%", "subtracts an overlap that cannot exist"), opt("20", "20%", "subtracts instead of adding")],
        correct: "40",
        explanation: "Rain and snow can't both happen, so the overlap is 0 and the shares simply add: 30% + 10% = 40%. Multiplying is for “and” under independence, not “or”.",
        rubric: { keyIdeas: ["mutually exclusive events add", "overlap is zero"], commonFlaws: ["multiplying for or"] },
        difficulty: 2,
      },
    ],
    reasoning: {
      sound: /outcome|overlap|exclusive|complement|cover|count/i,
      flawed: /multipl|convention|percent|equally likely/i,
      misconception: { label: "adds overlapping probabilities without correction", description: "Adds P(A) and P(B) even when outcomes are shared, double-counting the overlap." },
    },
  },
  {
    slug: "conditional-probability",
    name: "Conditional probability",
    definition: "The probability of A once we know B occurred: $P(A\\mid B) = P(A \\cap B)/P(B)$, i.e. the share of B's outcomes that are also in A.",
    prerequisites: ["probability"],
    role: "background",
    keywords: /conditional probabilit/i,
    explanations: {
      first_principles: {
        title: "Conditioning shrinks the world",
        body: `**Why we need this:** sequence models are built entirely out of statements like "how likely is the next symbol, *given* what came before?". That "given" is conditional probability.

Start from the unconditional truth: *learning that $B$ happened rules out every outcome outside $B$.* The world shrinks to $B$.

Inside that smaller world, $A$ can only happen in the outcomes that are in **both** $A$ and $B$. The question becomes: what share of $B$ does $A \\cap B$ take up?`,
        equation: {
          latex: "P(A \\mid B) = \\frac{P(A \\cap B)}{P(B)}",
          purpose: "Turns 'how likely is A, now that we know B' into quantities about the original, unshrunk world.",
          terms: [
            { symbol: "P(A \\cap B)", meaning: "how much of the original world has both A and B, the part of A that survives once we know B" },
            { symbol: "P(B)", meaning: "the size of the new, shrunk world" },
            { symbol: "P(A \\mid B)", meaning: "A's share of the shrunk world" },
          ],
          behavior: [
            "If B is small but A covers most of it, the result is close to 1 even when P(A) overall is small.",
            "If A and B never overlap, the numerator is 0: once B is known, A is impossible.",
            "Dividing by P(B) ≤ 1 rescales the shrunk world so its probabilities again total 1, so the result is never smaller than P(A ∩ B).",
          ],
          assumptions: ["P(B) > 0: you cannot condition on something impossible."],
          derivation: "Within B, the outcomes keep their *relative* sizes. The only consistent way to make them total 1 again is to divide every share by P(B). A's share is then P(A ∩ B)/P(B).",
        },
      },
      worked_example: {
        title: "Conditioning by counting a table",
        body: `Picture 100 students:

| | Economics | No economics | Total |
|---|---|---|---|
| **Statistics** | 10 | 30 | 40 |
| **No statistics** | 15 | 45 | 60 |

"Given a student takes statistics" means: **look only at the Statistics row** (40 students). Of those, 10 take economics, so $P(\\text{econ} \\mid \\text{stats}) = 10/40 = 0.25$.

Swap the condition: "given economics" means **look only at the Economics column** (25 students), and 10 of those take statistics: $P(\\text{stats} \\mid \\text{econ}) = 10/25 = 0.4$.

Same overlap (10), different denominators. **The thing after the bar decides which row or column you are restricted to.**`,
      },
      analogy: {
        title: "Conditioning as a spotlight",
        body: `Think of all outcomes as a stage, and $B$ as a spotlight. Once you know $B$ happened, you only watch what's inside the spotlight.

$P(A \\mid B)$ asks: *of everything lit by the spotlight, how much is $A$?* That's the overlap divided by the spotlight's size.

$P(B \\mid A)$ moves the spotlight onto $A$ instead. The lit area changes, so the answer changes, even though the overlap is the same.`,
        analogy: {
          text: "Knowing B is like a spotlight: only outcomes inside B are still visible.",
          breaksDown: "A spotlight suggests the rest of the stage still exists while you ignore it. Conditioning does more than hide outcomes: it rescales what remains so it totals 1. And unlike a spotlight, the size of B (its probability) is not just visual area; outcomes can have unequal weights.",
        },
      },
      contrasting_cases: {
        title: "P(A | B) versus P(B | A): two different questions",
        body: `Compare two statements about a medical test:

1. $P(\\text{positive} \\mid \\text{condition}) = 0.9$: among people **who have the condition**, 90% test positive.
2. $P(\\text{condition} \\mid \\text{positive})$: among people **who test positive**, what fraction have the condition?

They share the same overlap (people with the condition who test positive) but divide by different groups. If the condition is rare (1%) and 5% of everyone tests positive:

$$P(\\text{condition} \\mid \\text{positive}) = \\frac{0.9 \\times 0.01}{0.05} = 0.18$$

Only 18%, not 90%. Swapping the two sides of the bar is the single most common error with conditional probability, and it can be off by a factor of five or more.`,
      },
    },
    questions: [
      {
        stem: "In a class, 40% of students take statistics, 25% take economics, and 10% take both. What is $P(\\text{economics} \\mid \\text{statistics})$?",
        kind: "conceptual", context: "original", scenario: "students statistics and economics",
        options: [opt("0.25", "0.25"), opt("0.40", "0.40", "confuses P(A|B) with P(B|A)"), opt("0.10", "0.10", "treats the conditional as the joint probability"), opt("0.04", "0.04", "multiplies instead of dividing")],
        correct: "0.25",
        explanation: "Restrict to statistics students (0.40). Of those, 0.10 also take economics: $0.10/0.40 = 0.25$. 0.40 is $P(\\text{stats}\\mid\\text{econ}) = 0.10/0.25$, which has the condition swapped.",
        rubric: { keyIdeas: ["restrict to statistics students", "divide the overlap by P(statistics)"], commonFlaws: ["dividing by P(economics)"] },
        difficulty: 2,
      },
      {
        stem: "Why does the definition $P(A \\mid B) = P(A \\cap B) / P(B)$ divide by $P(B)$?",
        kind: "causal", context: "original", scenario: "why divide by P(B)",
        options: [opt("rescale", "Knowing B shrinks the possible outcomes to B, so shares are rescaled to total 1 within B"), opt("remove-a", "Dividing by P(B) removes the outcomes where A happened", "thinks conditioning removes A's outcomes"), opt("indep", "Dividing converts a joint probability into an independent one", "conflates conditioning with independence"), opt("smaller", "Dividing makes the result smaller than the joint probability", "thinks conditioning always lowers a probability")],
        correct: "rescale",
        explanation: "Conditioning restricts the world to B. The overlap $P(A\\cap B)$ is A's piece of that world, and dividing by B's size rescales so the restricted world totals 1. Since $P(B) \\le 1$, the result is never smaller than the joint.",
        rubric: { keyIdeas: ["the world shrinks to B", "renormalise so probabilities in B sum to 1"], commonFlaws: ["dividing makes it smaller"] },
        difficulty: 3,
      },
      {
        stem: "A screening test has $P(\\text{positive} \\mid \\text{condition}) = 0.9$. The condition affects 1% of people, and 5% of all people test positive. What is $P(\\text{condition} \\mid \\text{positive})$?",
        kind: "application", context: "original", scenario: "medical screening test",
        options: [opt("0.18", "0.18"), opt("0.9", "0.90", "confuses P(A|B) with P(B|A)"), opt("0.009", "0.009", "reports the joint probability"), opt("0.05", "0.05", "reports the probability of the condition being tested for")],
        correct: "0.18",
        explanation: "The overlap is $P(\\text{positive} \\cap \\text{condition}) = 0.9 \\times 0.01 = 0.009$. Restrict to positives (0.05): $0.009 / 0.05 = 0.18$. 0.90 answers the reverse question.",
        rubric: { keyIdeas: ["joint = 0.9 × 0.01", "divide by P(positive)"], commonFlaws: ["P(condition|positive) equals P(positive|condition)"] },
        difficulty: 4,
      },
      {
        stem: "In a music library, 30% of songs are jazz and 12% are jazz *and* instrumental. If the current song is jazz, how likely is it to be instrumental?",
        kind: "application", context: "novel", scenario: "jazz playlist instrumental",
        options: [opt("0.4", "0.40"), opt("0.12", "0.12", "treats the conditional as the joint probability"), opt("0.036", "0.036", "multiplies instead of dividing"), opt("0.3", "0.30", "reports the probability of the conditioning event")],
        correct: "0.4",
        explanation: "Restrict to jazz songs (0.30); instrumental jazz is 0.12 of all songs, so its share of the jazz world is $0.12/0.30 = 0.4$.",
        rubric: { keyIdeas: ["restrict to jazz", "0.12 divided by 0.30"], commonFlaws: ["multiplying 0.12 by 0.3"] },
        difficulty: 2,
      },
      {
        stem: "A transit report says $P(\\text{train late} \\mid \\text{rain}) = 0.3$. Which is the best plain-language reading?",
        kind: "plain_language", context: "original", scenario: "late trains in rain",
        options: [opt("rainy", "On rainy days, the train is late 30% of the time"), opt("late", "When the train is late, it is raining 30% of the time", "confuses P(A|B) with P(B|A)"), opt("joint", "On 30% of all days it rains and the train is late", "treats the conditional as the joint probability"), opt("more", "Rain makes the train 30% more likely to be late", "reads a conditional probability as a relative increase")],
        correct: "rainy",
        explanation: "The condition (after the bar) picks the group you look at: rainy days. Within that group, 30% have a late train. The reverse statement restricts to late-train days instead.",
        rubric: { keyIdeas: ["restrict to rainy days", "30% of that group"], commonFlaws: ["reading it as late days"] },
        difficulty: 2,
      },
      {
        stem: "A survey reports both $P(\\text{smoker} \\mid \\text{disease})$ and $P(\\text{disease} \\mid \\text{smoker})$. Which statement about these two numbers is true?",
        kind: "compare", context: "novel", scenario: "smokers and disease survey",
        options: [opt("differ", "They share the same overlap but divide by different groups, so they can differ"), opt("equal", "They are always equal, because they describe the same group of people", "confuses P(A|B) with P(B|A)"), opt("larger", "The first is always larger, because the disease is rarer than smoking", "thinks the rarer condition always gives the larger value"), opt("sum", "They must add up to 1, because one is the reverse of the other", "confuses reversed conditionals with complements")],
        correct: "differ",
        explanation: "Both have numerator $P(\\text{smoker} \\cap \\text{disease})$, but one divides by $P(\\text{disease})$ and the other by $P(\\text{smoker})$. Unless those are equal, the two conditionals differ.",
        rubric: { keyIdeas: ["same numerator", "different denominators"], commonFlaws: ["they are equal"] },
        difficulty: 3,
      },
      {
        stem: "A friend says: “$P(\\text{spam} \\mid \\text{contains 'free'}) = 0.8$, so 80% of spam emails contain the word 'free'.” What is wrong with this reasoning?",
        kind: "diagnose_explanation", context: "novel", scenario: "spam filter word free",
        options: [opt("swap", "It swaps the condition: 0.8 describes emails with 'free', not spam emails"), opt("fine", "Nothing: the two statements describe exactly the same quantity", "confuses P(A|B) with P(B|A)"), opt("complement", "It should say 20%, because conditioning takes the complement", "confuses conditioning with the complement"), opt("percent", "Conditional probabilities can never be stated as percentages", "thinks the error is about notation")],
        correct: "swap",
        explanation: "$P(\\text{spam}\\mid\\text{free})$ restricts to emails containing 'free'. “80% of spam contains 'free'” is $P(\\text{free}\\mid\\text{spam})$, which restricts to spam. They can be very different numbers.",
        rubric: { keyIdeas: ["the bar decides which group you restrict to", "P(spam|free) ≠ P(free|spam)"], commonFlaws: ["the two are equal"] },
        difficulty: 3,
      },
    ],
    reasoning: {
      sound: /restrict|given|within|out of|only (look|consider)|divide (by|the overlap by) p\(b\)|renormal|shrink|row|column/i,
      flawed: /same (thing|quantity)|swap|either way|symmetric|interchangeab|p\(b ?\| ?a\) ?= ?p\(a ?\| ?b\)|divide by p\(a\)|multipl/i,
      misconception: { label: "confuses P(A|B) with P(B|A)", description: "Treats the event and the condition as interchangeable, ignoring that the condition decides which group you restrict to." },
    },
  },
  {
    slug: "chain-rule-of-probability",
    name: "Chain rule of probability",
    definition: "Any joint probability factorises exactly into a product of conditionals: $P(x_1,\\dots,x_n) = \\prod_t P(x_t \\mid x_1,\\dots,x_{t-1})$.",
    prerequisites: ["conditional-probability"],
    role: "central",
    keywords: /chain rule/i,
    explanations: {
      first_principles: {
        title: "Building a sequence one step at a time",
        body: `**Why we need this:** we want the probability of a whole sequence (a week of weather, a sentence). Sequences are produced one item at a time, so we want to compute their probability one item at a time too.

Rearrange the definition of conditional probability, which you already trust: $P(A \\cap B) = P(A)\\,P(B \\mid A)$. Apply it again with $C$: $P(A,B,C) = P(A,B)\\,P(C \\mid A,B) = P(A)\\,P(B\\mid A)\\,P(C \\mid A,B)$. Keep going and you get the chain rule. **No assumption was made**; it is exact for any sequence.`,
        equation: {
          latex: "P(x_1,\\dots,x_n) = \\prod_{t=1}^{n} P(x_t \\mid x_1,\\dots,x_{t-1})",
          purpose: "Expresses the probability of a whole sequence as 'how likely was each step, given everything before it'.",
          terms: [
            { symbol: "x_t", meaning: "the item at position t (today's weather, the t-th word)" },
            { symbol: "x_1,\\dots,x_{t-1}", meaning: "the entire history before step t" },
            { symbol: "\\prod", meaning: "multiply the step probabilities together, since every step must happen" },
          ],
          behavior: [
            "Each extra step multiplies in another factor ≤ 1, so longer sequences have smaller probabilities.",
            "The conditioning history grows with t, so later factors condition on more and more.",
          ],
          assumptions: ["None: the chain rule is an identity. The difficulty is that the history keeps growing."],
        },
      },
      worked_example: {
        title: "Chain rule on three days of weather",
        body: `Three days: sun, sun, rain.

$$P(\\text{sun},\\text{sun},\\text{rain}) = P(\\text{sun}) \\cdot P(\\text{sun} \\mid \\text{sun}) \\cdot P(\\text{rain} \\mid \\text{sun},\\text{sun})$$

With $0.6$, $0.7$ and $0.2$: $0.6 \\times 0.7 \\times 0.2 = 0.084$.

Notice the last factor conditions on **both** earlier days. The chain rule never drops history; dropping it is a separate *assumption* that comes next.`,
      },
    },
    questions: [
      {
        stem: "Which expression equals $P(A, B, C)$ for *any* three events, with no assumptions?",
        kind: "conceptual", context: "original", scenario: "three-event factorisation",
        options: [opt("chain", "$P(A)\\,P(B\\mid A)\\,P(C\\mid A,B)$"), opt("indep", "$P(A)\\,P(B)\\,P(C)$", "assumes independence without justification"), opt("markov", "$P(A)\\,P(B\\mid A)\\,P(C\\mid B)$", "drops part of the history (assumes Markov silently)"), opt("both", "$P(C\\mid A,B)\\,P(A,B\\mid C)$", "conditions in both directions")],
        correct: "chain",
        explanation: "Apply $P(X\\cap Y) = P(X)P(Y\\mid X)$ twice. The other forms are only true under extra assumptions (independence, or a Markov property).",
        rubric: { keyIdeas: ["each factor conditions on everything before it", "no assumption needed"], commonFlaws: ["dropping A from the last factor"] },
        difficulty: 2,
      },
      {
        stem: "Why is the chain rule exact for every sequence, with no assumptions?",
        kind: "causal", context: "original", scenario: "why chain rule is exact",
        options: [opt("definition", "Each factor is the definition of conditional probability, rearranged and applied repeatedly"), opt("independent", "Because the events in a sequence are independent of one another", "thinks the chain rule relies on independence"), opt("previous", "Because each event depends only on the one before it", "confuses the chain rule with the Markov assumption"), opt("approx", "Because it is an approximation that becomes exact for long sequences", "thinks the chain rule is approximate")],
        correct: "definition",
        explanation: "$P(X,Y) = P(X)P(Y\\mid X)$ is just the definition of $P(Y \\mid X)$ multiplied out. Repeating it gives the chain rule, so it inherits exactness from the definition.",
        rubric: { keyIdeas: ["rearranged definition of conditional probability", "applied repeatedly"], commonFlaws: ["needs independence"] },
        difficulty: 3,
      },
      {
        stem: "$P(\\text{sun on day 1}) = 0.6$, $P(\\text{sun day 2} \\mid \\text{sun day 1}) = 0.7$, $P(\\text{rain day 3} \\mid \\text{sun days 1–2}) = 0.2$. What is $P(\\text{sun}, \\text{sun}, \\text{rain})$?",
        kind: "application", context: "original", scenario: "three days weather product",
        options: [opt("0.084", "0.084"), opt("0.336", "0.336", "uses the complement for the final factor"), opt("0.42", "0.42", "stops after two factors"), opt("1.5", "1.5", "adds the factors instead of multiplying")],
        correct: "0.084",
        explanation: "Multiply each step's conditional probability: $0.6 \\times 0.7 \\times 0.2 = 0.084$. All three steps must happen, so the probabilities multiply.",
        rubric: { keyIdeas: ["multiply the three step probabilities"], commonFlaws: ["adding probabilities"] },
        difficulty: 2,
      },
      {
        stem: "A text model computes $P(\\text{'the cat sat'})$ exactly with the chain rule. Which factor is **not** part of that exact decomposition?",
        kind: "compare", context: "novel", scenario: "sentence the cat sat",
        options: [opt("sat-cat", "$P(\\text{sat} \\mid \\text{cat})$"), opt("the", "$P(\\text{the})$", "thinks the first word must also be conditioned"), opt("cat-the", "$P(\\text{cat} \\mid \\text{the})$", "thinks conditioning on one word is always an approximation"), opt("sat-the-cat", "$P(\\text{sat} \\mid \\text{the}, \\text{cat})$", "thinks the chain rule never conditions on more than one word")],
        correct: "sat-cat",
        explanation: "The exact factor for 'sat' conditions on the whole history, 'the cat'. $P(\\text{sat}\\mid\\text{cat})$ drops 'the', which is the first-order Markov *approximation*, not the chain rule.",
        rubric: { keyIdeas: ["exact factors condition on the full history"], commonFlaws: ["P(sat|cat) is exact"] },
        difficulty: 3,
      },
    ],
    reasoning: {
      sound: /definition|rearrang|whole history|everything before|all previous|full history|multiply/i,
      flawed: /independen|only the (last|previous)|approximat|add/i,
      misconception: { label: "treats the chain rule as requiring independence", description: "Believes factorising a joint probability needs independence or a Markov assumption." },
    },
  },
  {
    slug: "markov-assumption",
    name: "Markov assumption",
    definition: "The assumption that, given a limited recent history (for first order, just the current state), the next state is conditionally independent of all earlier states.",
    prerequisites: ["conditional-probability", "chain-rule-of-probability"],
    role: "central",
    keywords: /markov assumption|limited history|why we need assumptions|exponential/i,
    explanations: {
      first_principles: {
        title: "Why sequence models cut off the history",
        body: `**The problem:** the chain rule is exact, but its last factor $P(x_t \\mid x_1,\\dots,x_{t-1})$ conditions on the *entire* history. With $k$ possible symbols there are $k^{t-1}$ histories, so a model of 20-step weather with 2 states would need about a million different conditional distributions. We can never estimate that many.

**The move:** assume that only the recent past matters. The first-order **Markov assumption** says:

$$P(x_t \\mid x_1,\\dots,x_{t-1}) = P(x_t \\mid x_{t-1})$$

This does **not** say states are independent. Tomorrow still depends strongly on today. It says that *once you know today*, knowing earlier days adds nothing. Today "screens off" the past.`,
      },
      contrasting_cases: {
        title: "Three models of a sequence, compared",
        body: `| Model | Next symbol depends on | Parameters (k symbols) |
|---|---|---|
| Independent | nothing | $k$ |
| First-order Markov | the previous symbol | $\\approx k^2$ |
| Full history | everything before | grows like $k^{t}$ |

The independent model is cheap but can't capture *"u almost always follows q"*. Full history captures everything but can't be estimated. The Markov assumption is the middle ground: **dependence on the recent past, independence from the rest once the recent past is known.**`,
      },
      analogy: {
        title: "A board game position",
        body: `In a board game like Snakes and Ladders, your next square depends on where you are now and the die roll. *How* you got to your current square doesn't matter: your position already summarises everything relevant.

That is the Markov assumption: the current state is a complete summary of the past *for the purpose of predicting the next step*.`,
        analogy: {
          text: "A game position summarises the past; the path you took to reach it is irrelevant for the next move.",
          breaksDown: "In a board game this is exactly true by the rules. In real data (weather, language) it is an approximation we choose. Earlier history usually does carry some information, and we accept losing it to make the model learnable.",
        },
      },
    },
    questions: [
      {
        stem: "The first-order Markov assumption says that…",
        kind: "conceptual", context: "original", scenario: "statement of Markov assumption",
        options: [opt("screen", "given the current state, the next state does not depend on earlier states"), opt("indep", "consecutive states are independent of each other", "thinks the Markov assumption means no dependence at all"), opt("equal", "the next state depends on all earlier states equally", "thinks every past state contributes equally"), opt("stationary", "each state has the same probability at every time step", "confuses the Markov property with stationarity")],
        correct: "screen",
        explanation: "The Markov property is *conditional* independence: the present screens off the past. Consecutive states are usually strongly dependent; that dependence is exactly what the transition probabilities capture.",
        rubric: { keyIdeas: ["conditional on the present", "earlier states add no further information"], commonFlaws: ["states are independent"] },
        difficulty: 2,
      },
      {
        stem: "Why do sequence models make a limited-history assumption at all, given that the chain rule is already exact?",
        kind: "causal", context: "original", scenario: "why limit the history",
        options: [opt("exponential", "Because the number of histories to model grows exponentially"), opt("true", "Because real sequences never depend on the distant past", "thinks the assumption is literally true of real data"), opt("undefined", "Because conditional probabilities are undefined for long histories", "thinks long conditionals are mathematically invalid"), opt("short", "Because the chain rule only holds for short sequences", "thinks the chain rule is approximate")],
        correct: "exponential",
        explanation: "With $k$ symbols there are $k^{t-1}$ possible histories. Each needs its own distribution, far more than any dataset can estimate. Limiting the history trades a little accuracy for a learnable model.",
        rubric: { keyIdeas: ["number of histories grows exponentially", "too many parameters to estimate"], commonFlaws: ["the past doesn't matter"] },
        difficulty: 3,
      },
      {
        stem: "A first-order Markov weather model already knows today is rainy. You then learn that last week was unusually dry. How should that change the model's prediction for tomorrow?",
        kind: "application", context: "original", scenario: "rainy today dry last week",
        options: [opt("none", "It shouldn't change it: given today, the model ignores earlier days"), opt("lots", "It should change it a lot, because dry spells tend to persist", "applies outside intuition instead of the model's assumption"), opt("indep", "Tomorrow should also become independent of today", "thinks the Markov assumption means no dependence at all"), opt("average", "It should average today and last week with equal weight", "thinks every past state contributes equally")],
        correct: "none",
        explanation: "Under the first-order assumption, today screens off the past: once 'rainy today' is known, last week's weather carries no extra information *for this model*. Whether that's realistic is a separate question about the assumption.",
        rubric: { keyIdeas: ["today screens off earlier days", "this is the model's assumption, not a fact about weather"], commonFlaws: ["tomorrow becomes independent of today"] },
        difficulty: 3,
      },
      {
        stem: "An analyst models daily stock moves (up/down) as a first-order Markov chain. What does that model assume?",
        kind: "assumptions", context: "novel", scenario: "stock market moves",
        options: [opt("summary", "Today's move carries all the information from past moves that matters for tomorrow"), opt("coins", "Daily moves are independent, like coin flips", "thinks the Markov assumption means no dependence at all"), opt("determined", "Tomorrow's move is fully determined by today's move", "confuses probabilistic dependence with determinism"), opt("same", "Tomorrow's move has the same probabilities regardless of today", "confuses the Markov property with independence of the next state")],
        correct: "summary",
        explanation: "First-order Markov: tomorrow depends on today, and earlier days add nothing once today is known. It is still probabilistic, and it is an assumption the analyst should test.",
        rubric: { keyIdeas: ["today screens off earlier days", "still probabilistic"], commonFlaws: ["moves are independent"] },
        difficulty: 3,
      },
      {
        stem: "Someone models text as independent words: $P(w_1,\\dots,w_n) = \\prod_i P(w_i)$. Why does this fail where a first-order Markov model does not?",
        kind: "why_alternative_fails", context: "novel", scenario: "independent word model",
        options: [opt("context", "It cannot capture that some words are far more likely right after particular words"), opt("gt1", "It produces probabilities larger than 1 for long sentences", "misunderstands products of probabilities"), opt("params", "It needs more parameters than a Markov model", "thinks independence is the more complex model"), opt("unseen", "It cannot assign probability to words it has never seen", "confuses the independence flaw with sparse data")],
        correct: "context",
        explanation: "Independence throws away *all* dependence between words, so 'of the' and 'the of' get the same probability. A Markov model keeps dependence on the previous word.",
        rubric: { keyIdeas: ["independence ignores word order and context", "Markov keeps dependence on the previous word"], commonFlaws: ["more parameters"] },
        difficulty: 3,
      },
    ],
    reasoning: {
      sound: /given|screen|summar|conditional|once (you|we) know|exponential|too many/i,
      flawed: /independen(t|ce) of each other|no (dependence|effect)|coin|doesn'?t matter at all|unrelated/i,
      misconception: { label: "thinks the Markov assumption means states are independent", description: "Reads 'memoryless' as 'no dependence', instead of 'the present screens off the past'." },
    },
  },
  {
    slug: "first-order-markov-model",
    name: "First-order Markov model",
    definition: "A sequence model where $P(x_t \\mid x_{1:t-1}) = P(x_t \\mid x_{t-1})$, fully described by an initial distribution and a $k \\times k$ transition matrix.",
    prerequisites: ["markov-assumption", "chain-rule-of-probability"],
    role: "central",
    keywords: /first[- ]order|transition matri/i,
    explanations: {
      first_principles: {
        title: "A model made of one-step transitions",
        body: `Combine the two ideas you have: the chain rule (exact) and the Markov assumption (a chosen simplification).

$$P(x_1,\\dots,x_n) = P(x_1)\\prod_{t=2}^{n} P(x_t \\mid x_{t-1})$$

Every factor now has the same shape: *from state $i$, how likely is state $j$ next?* Collect those numbers in a **transition matrix** $A$ with $A_{ij} = P(x_t = j \\mid x_{t-1} = i)$. Each row is a probability distribution, so each row sums to 1.`,
        equation: {
          latex: "A_{ij} = P(x_t = j \\mid x_{t-1} = i)",
          purpose: "Stores the entire model: one probability for each (current state, next state) pair.",
          terms: [
            { symbol: "i", meaning: "the current state (row)" },
            { symbol: "j", meaning: "the candidate next state (column)" },
            { symbol: "A_{ij}", meaning: "how likely the move i → j is" },
          ],
          behavior: [
            "Raising A_ij makes the move i → j more common; another entry in row i must drop, because the row sums to 1.",
            "A large diagonal entry A_ii makes the chain 'sticky': states persist.",
            "The same matrix is used at every step (time-homogeneous), so the model has about k² numbers no matter how long the sequence.",
          ],
          assumptions: ["Markov property (only the current state matters)", "Time-homogeneity (same transitions at every step)"],
        },
      },
      worked_example: {
        title: "Two days ahead in a weather chain",
        body: `Transitions: sun→sun 0.8, sun→rain 0.2, rain→sun 0.4, rain→rain 0.6. Today is sunny. What is the chance of rain **in two days**?

There are two paths to rain on day 2:
- sun → **sun** → rain: $0.8 \\times 0.2 = 0.16$
- sun → **rain** → rain: $0.2 \\times 0.6 = 0.12$

Add the paths, since they are mutually exclusive: $0.28$. (This is the (sun, rain) entry of $A^2$: matrix multiplication *is* summing over intermediate states.)`,
      },
    },
    questions: [
      {
        stem: "In a first-order Markov weather model with states {sun, rain}, what do you need to predict tomorrow's weather?",
        kind: "conceptual", context: "original", scenario: "what to predict tomorrow",
        options: [opt("today", "$P(\\text{tomorrow} \\mid \\text{today})$ and today's weather"), opt("month", "$P(\\text{tomorrow} \\mid \\text{the whole past month})$", "thinks the model needs the entire history"), opt("marginal", "$P(\\text{tomorrow})$ alone", "ignores the dependence on today"), opt("reverse", "$P(\\text{today} \\mid \\text{tomorrow})$", "reverses the direction of conditioning")],
        correct: "today",
        explanation: "Under first-order Markov, today's state plus the transition probabilities are all you need. The rest of the history is screened off.",
        rubric: { keyIdeas: ["only today's state matters", "transition probabilities"], commonFlaws: ["needs the whole history"] },
        difficulty: 1,
      },
      {
        stem: "Transitions: sun→sun 0.8, sun→rain 0.2, rain→sun 0.4, rain→rain 0.6. Today is sunny. What is $P(\\text{rain in exactly two days})$?",
        kind: "multi_step", context: "original", scenario: "two-step weather forecast",
        options: [opt("0.28", "0.28"), opt("0.2", "0.20", "uses the one-step probability"), opt("0.12", "0.12", "considers only one of the two paths"), opt("0.04", "0.04", "multiplies the one-step probability by itself")],
        correct: "0.28",
        explanation: "Sum over tomorrow's state: $0.8\\times0.2 + 0.2\\times0.6 = 0.16 + 0.12 = 0.28$.",
        rubric: { keyIdeas: ["sum over the intermediate state", "two paths"], commonFlaws: ["only one path"] },
        difficulty: 3,
      },
      {
        stem: "Why does a first-order Markov model with $k$ states need about $k^2$ transition probabilities?",
        kind: "causal", context: "original", scenario: "parameter count first order",
        options: [opt("pairs", "There is one probability for each (current state, next state) pair"), opt("perstate", "There is one probability per state, giving how likely that state is", "confuses transition probabilities with state probabilities"), opt("cube", "Three states are involved in each step, giving $k^3$", "applies the second-order count"), opt("inout", "Each state has one incoming and one outgoing probability, giving $2k$", "thinks transitions are per state rather than per pair")],
        correct: "pairs",
        explanation: "The matrix has a row for each current state and a column for each next state: $k \\times k$ entries (with $k(k-1)$ free, since rows sum to 1).",
        rubric: { keyIdeas: ["one entry per pair", "rows sum to 1"], commonFlaws: ["one per state"] },
        difficulty: 2,
      },
      {
        stem: "In Snakes and Ladders, your next square depends only on your current square and a die roll. Why is this naturally a first-order Markov chain?",
        kind: "causal", context: "novel", scenario: "snakes and ladders",
        options: [opt("summary", "The current square summarises everything about the past that affects the next move"), opt("indep", "The die rolls make the squares independent of each other", "thinks the Markov assumption means no dependence at all"), opt("ends", "The game always ends, so the chain is finite", "confuses finiteness with the Markov property"), opt("equal", "Every square is equally likely to be visited", "confuses the Markov property with uniformity")],
        correct: "summary",
        explanation: "Given your current square, how you got there is irrelevant to where you go next. That is exactly the Markov property.",
        rubric: { keyIdeas: ["current square screens off the path taken"], commonFlaws: ["squares are independent"] },
        difficulty: 2,
      },
    ],
    reasoning: {
      sound: /current|today|previous (state|day)|pair|path|sum over|screen|summar/i,
      flawed: /whole history|entire past|independen|one per state/i,
      misconception: { label: "thinks a first-order model needs the whole history", description: "Does not apply the Markov simplification when computing transitions." },
    },
  },
  {
    slug: "second-order-markov-model",
    name: "Second-order Markov model",
    definition: "A sequence model where $P(x_t \\mid x_{1:t-1}) = P(x_t \\mid x_{t-1}, x_{t-2})$: the next state depends on the previous two states and on nothing earlier.",
    prerequisites: ["first-order-markov-model", "conditional-probability"],
    role: "central",
    keywords: /second[- ]order|pair of previous/i,
    explanations: {
      first_principles: {
        title: "When one step of memory is not enough",
        body: `**Why we need this:** a first-order model forgets everything except the last state. Sometimes the last state is ambiguous. In English, the letter after "h" depends a lot on whether you're in "th" or "ch". One letter of memory can't tell those apart; two can.

**The move:** keep the chain rule, but make a *weaker* Markov assumption that keeps two steps of history:`,
        equation: {
          latex: "P(x_t \\mid x_1,\\dots,x_{t-1}) = P(x_t \\mid x_{t-1}, x_{t-2})",
          purpose: "Lets the prediction depend on the last two states, so contexts that look identical to a first-order model can be told apart.",
          terms: [
            { symbol: "x_t", meaning: "the state being predicted" },
            { symbol: "x_{t-1}", meaning: "the most recent state" },
            { symbol: "x_{t-2}", meaning: "the state before that; this term is what a first-order model drops" },
          ],
          behavior: [
            "Remove the x_{t-2} term and you get the first-order model back.",
            "If x_t really doesn't depend on x_{t-2}, the second-order probabilities for (a, b) and (c, b) come out equal, and the extra term does no harm except cost.",
            "The number of contexts grows from k to k², so each needs its own distribution over k next states: about k³ numbers, and much more data.",
          ],
          assumptions: ["Given the last two states, everything earlier is irrelevant", "The same probabilities apply at every position"],
        },
      },
      contrasting_cases: {
        title: "First-order versus second-order, side by side",
        body: `Take the sequence *... rain, sun, ?* and ask what comes next.

- **First-order** looks only at "sun" and uses $P(\\cdot \\mid \\text{sun})$. It gives the same answer after *(rain, sun)* and after *(sun, sun)*.
- **Second-order** looks at the pair *(rain, sun)* and uses $P(\\cdot \\mid \\text{sun}, \\text{rain})$, which can differ from $P(\\cdot \\mid \\text{sun}, \\text{sun})$. For example, a single sunny day after rain may be less stable than a sunny spell.

"Second order" is about **how much history you condition on**: two steps. It is not about predicting two steps ahead, and not about squaring anything.`,
      },
      worked_example: {
        title: "Turning a second-order chain into a first-order one",
        body: `Trick: make the **state a pair**. Define $s_t = (x_{t-1}, x_t)$. Then

$$P(s_{t+1} \\mid s_t, s_{t-1}, \\dots) = P(s_{t+1} \\mid s_t)$$

because $s_t$ already contains $x_t$ and $x_{t-1}$, which is everything the second-order model needs.

With weather {sun, rain}, the pair-states are (sun,sun), (sun,rain), (rain,sun), (rain,rain). From (rain, sun) you can only move to (sun, sun) or (sun, rain): the first element of the next pair must equal the second element of this one.

So **everything you know about first-order chains still works**, on a bigger state space of $k^2$ states.`,
      },
      analogy: {
        title: "Reading with a two-letter window",
        body: `Imagine reading text through a slot that shows only the last letter you read, and guessing the next one. After "h" you are stuck: is it "th…", "sh…", "ch…"? Widen the slot to two letters and "th" vs "ch" becomes visible, and your guesses improve.

A second-order model is the two-letter slot.`,
        analogy: {
          text: "A second-order model reads the sequence through a window showing the last two items.",
          breaksDown: "A reader also uses meaning, grammar and words further back. The model uses *only* the two items in the window, and it can't widen the window when the context is ambiguous. The window also says nothing about how probabilities are estimated: that comes from counting.",
        },
      },
    },
    questions: [
      {
        stem: "A second-order Markov model of a sequence $x_1, x_2, \\dots$ assumes that…",
        kind: "conceptual", context: "original", scenario: "statement of second order",
        options: [opt("two", "$x_t$ depends on the past only through $x_{t-1}$ and $x_{t-2}$"), opt("lag", "$x_t$ depends only on $x_{t-2}$", "thinks 'order' is the lag rather than the window"), opt("ahead", "the model predicts two steps ahead, $x_{t+2}$", "thinks 'second order' means predicting two steps ahead"), opt("square", "$x_t$ depends on the square of $x_{t-1}$", "thinks 'order' means a power")],
        correct: "two",
        explanation: "Order = how many previous states the prediction conditions on. Second-order conditions on the last two; everything earlier is screened off.",
        rubric: { keyIdeas: ["conditions on the previous two states", "earlier states are ignored"], commonFlaws: ["predicts two steps ahead"] },
        difficulty: 2,
      },
      {
        stem: "Why might a second-order model predict the next letter of English text better than a first-order model?",
        kind: "causal", context: "original", scenario: "english letters context",
        options: [opt("disambiguate", "Two preceding letters can tell apart contexts that the last letter alone cannot"), opt("alphabet", "It uses a larger alphabet of individual letters", "thinks higher order changes the symbol set"), opt("indep", "It assumes letters are independent, which simplifies estimation", "thinks the Markov assumption means no dependence at all"), opt("future", "It looks two letters ahead before choosing", "thinks the model uses future context")],
        correct: "disambiguate",
        explanation: "After 'h', the next letter depends on whether you're in 'th', 'sh' or 'ch'. A first-order model sees only 'h'; a second-order model sees the pair.",
        rubric: { keyIdeas: ["two letters of context", "disambiguates contexts"], commonFlaws: ["looks ahead"] },
        difficulty: 2,
      },
      {
        stem: "In a second-order weather model, which quantity gives the chance of rain tomorrow if it rained yesterday and is sunny today?",
        kind: "application", context: "original", scenario: "rain yesterday sun today",
        options: [opt("both", "$P(x_{t+1}=\\text{rain} \\mid x_t=\\text{sun},\\, x_{t-1}=\\text{rain})$"), opt("today", "$P(x_{t+1}=\\text{rain} \\mid x_t=\\text{sun})$", "drops the second state (first-order thinking)"), opt("older", "$P(x_{t+1}=\\text{rain} \\mid x_{t-1}=\\text{rain})$", "conditions only on the older state"), opt("joint", "$P(x_{t+1}=\\text{rain},\\, x_t=\\text{sun},\\, x_{t-1}=\\text{rain})$", "uses the joint instead of the conditional")],
        correct: "both",
        explanation: "Second order conditions on the last two states: today (sun) and yesterday (rain). The joint is a different quantity: it also includes the probability of the history itself.",
        rubric: { keyIdeas: ["condition on today and yesterday", "conditional, not joint"], commonFlaws: ["only today"] },
        difficulty: 2,
      },
      {
        stem: "With $k = 3$ states, how many *free* transition parameters does a second-order Markov model have?",
        kind: "multi_step", context: "original", scenario: "parameter count k equals three",
        options: [opt("18", "18"), opt("9", "9", "counts contexts but not outcomes"), opt("6", "6", "uses the first-order count"), opt("27", "27", "ignores that each distribution sums to 1")],
        correct: "18",
        explanation: "There are $k^2 = 9$ contexts (pairs). Each has a distribution over 3 next states, with 2 free numbers because they sum to 1: $9 \\times 2 = 18$.",
        rubric: { keyIdeas: ["k² contexts", "each distribution has k−1 free values"], commonFlaws: ["27"] },
        difficulty: 4,
      },
      {
        stem: "A melody generator chooses each note from the previous **two** notes. What can it capture that a model using only the previous note cannot?",
        kind: "application", context: "novel", scenario: "melody generator notes",
        options: [opt("pattern", "The same note being followed differently depending on the note before it"), opt("freq", "How often each individual note occurs overall", "thinks higher order only changes the overall frequencies"), opt("three", "Dependencies on notes three or more steps back", "overestimates how much history the model keeps"), opt("indep", "Melodies in which each note is independent of the others", "thinks the Markov assumption means no dependence at all")],
        correct: "pattern",
        explanation: "A note's continuation can now depend on the note before it: after C→E the model can prefer G, while after D→E it prefers F. Notes three back are still invisible.",
        rubric: { keyIdeas: ["context of two notes", "same last note, different continuations"], commonFlaws: ["remembers the whole melody"] },
        difficulty: 3,
      },
      {
        stem: "A biologist models DNA bases (A, C, G, T) with a second-order Markov chain. To predict the base after the stretch “…T G A”, the model uses:",
        kind: "application", context: "novel", scenario: "dna bases",
        options: [opt("ga", "$P(\\text{next} \\mid \\text{G}, \\text{A})$"), opt("a", "$P(\\text{next} \\mid \\text{A})$", "drops the second state (first-order thinking)"), opt("tga", "$P(\\text{next} \\mid \\text{T}, \\text{G}, \\text{A})$", "overestimates how much history the model keeps"), opt("marg", "$P(\\text{next})$", "ignores the dependence on previous states")],
        correct: "ga",
        explanation: "Second order: the last two bases, G then A. The T is outside the window.",
        rubric: { keyIdeas: ["last two bases"], commonFlaws: ["three bases"] },
        difficulty: 2,
      },
      {
        stem: "Which is the best plain-language description of a second-order Markov model?",
        kind: "plain_language", context: "original", scenario: "plain description",
        options: [opt("lasttwo", "Each item is predicted from the last two items; anything earlier is ignored"), opt("lastone", "Each item is predicted from the last item; the one before it is ignored", "describes a first-order model"), opt("weighted", "Each item is predicted from all earlier items, weighted by recency", "thinks the model keeps all history"), opt("pairs", "Items are generated two at a time, independently", "thinks 'second order' means emitting pairs independently")],
        correct: "lasttwo",
        explanation: "Two items of memory, nothing more.",
        rubric: { keyIdeas: ["last two items", "earlier items ignored"], commonFlaws: ["all history"] },
        difficulty: 1,
      },
    ],
    reasoning: {
      sound: /(previous|last) two|two (previous|preceding|prior)|pair|x_?\{?t-?2|t-1 and t-2|both/i,
      flawed: /ahead|future|squar|only (the )?(last|previous) (one|state|letter|note)|t\+2|power/i,
      misconception: { label: "thinks 'second-order' means predicting two steps ahead", description: "Reads the order as a prediction horizon or a power, rather than the number of past states conditioned on." },
    },
  },
  {
    slug: "estimating-transition-probabilities",
    name: "Estimating transition probabilities",
    definition: "The maximum-likelihood estimate of a Markov transition probability is a ratio of counts: how often the context was followed by the symbol, divided by how often the context occurred.",
    prerequisites: ["second-order-markov-model", "conditional-probability"],
    role: "central",
    keywords: /estimat|counting|count/i,
    explanations: {
      first_principles: {
        title: "Probabilities from counts",
        body: `**Why we need this:** the model is only useful once its numbers are filled in, and they come from data.

Conditional probability says: restrict to the cases where the context happened, then see what fraction also had the outcome. With data, "restrict" means **count**:

$$\\hat P(c \\mid a, b) = \\frac{\\text{count}(a, b, c)}{\\text{count}(a, b, \\cdot)}$$

The denominator counts how often the context $(a,b)$ appeared *with any continuation*. It is the data version of $P(B)$ in the definition of conditional probability.`,
        equation: {
          latex: "\\hat P(c \\mid a,b) = \\frac{N(a,b,c)}{\\sum_{c'} N(a,b,c')}",
          purpose: "Fills in each second-order transition probability from observed triples.",
          terms: [
            { symbol: "N(a,b,c)", meaning: "how many times the triple a, b, c appears" },
            { symbol: "\\sum_{c'} N(a,b,c')", meaning: "how many times the context (a, b) was followed by anything" },
          ],
          behavior: [
            "Rare contexts give noisy estimates: one extra observation can swing the ratio a lot.",
            "A triple never seen gets probability 0, even if it's perfectly possible (the sparsity problem; smoothing fixes it).",
          ],
          assumptions: ["The data were generated by a fixed second-order chain", "Enough observations of each context"],
        },
      },
      worked_example: {
        title: "Counting triples in a short sequence",
        body: `Sequence: **A B A B A C**. Its overlapping triples are ABA, BAB, ABA, BAC.

- Context (A, B) appears twice, followed by A both times → $\\hat P(A \\mid A,B) = 2/2 = 1$.
- Context (B, A) appears twice, followed once by B and once by C → $\\hat P(C \\mid B,A) = 1/2$.

Divide by how often **that context** occurred, not by the sequence length or the total number of triples.`,
      },
    },
    questions: [
      {
        stem: "From the sequence **A B A B A C**, what is the maximum-likelihood estimate of $P(C \\mid \\text{previous two} = B, A)$?",
        kind: "application", context: "original", scenario: "count triples ABABAC",
        options: [opt("1/2", "$\\tfrac{1}{2}$"), opt("1/6", "$\\tfrac{1}{6}$", "divides by the sequence length"), opt("1/4", "$\\tfrac{1}{4}$", "divides by all triples instead of those with that context"), opt("1", "$1$", "ignores the other continuation of the context")],
        correct: "1/2",
        explanation: "Context (B, A) occurs twice (BAB, BAC); once it is followed by C. So $1/2$. Dividing by all 4 triples mixes in other contexts.",
        rubric: { keyIdeas: ["count the context (B, A)", "divide by context occurrences"], commonFlaws: ["divide by total triples"] },
        difficulty: 3,
      },
      {
        stem: "Why does a second-order model typically need much more data than a first-order model to estimate well?",
        kind: "causal", context: "original", scenario: "data requirements",
        options: [opt("split", "Its counts are split across $k^2$ contexts, so each context is observed fewer times"), opt("twice", "It needs exactly twice as much data because it looks back twice as far", "thinks parameters grow linearly with order"), opt("formula", "Its probabilities use a more complicated formula", "thinks difficulty comes from the formula rather than the counts"), opt("future", "It must also estimate future states", "thinks the model uses future context")],
        correct: "split",
        explanation: "The same data is divided among $k^2$ contexts instead of $k$, so each context gets roughly $1/k$ as many observations. Estimates get noisier and more triples are never seen.",
        rubric: { keyIdeas: ["more contexts", "fewer observations per context"], commonFlaws: ["twice the data"] },
        difficulty: 3,
      },
      {
        stem: "To estimate $P(\\text{next} \\mid \\text{previous two})$, someone counts only *pairs* (previous, next) instead of triples. What goes wrong?",
        kind: "why_alternative_fails", context: "original", scenario: "counting pairs instead of triples",
        options: [opt("first", "It ignores the earlier state, so it actually estimates a first-order model"), opt("sum", "The estimated probabilities no longer sum to 1", "thinks pair counts break normalisation"), opt("nothing", "Nothing: pairs contain the same information as triples", "thinks pairs and triples carry the same information"), opt("zero", "Every probability becomes zero", "overgeneralises the sparsity problem")],
        correct: "first",
        explanation: "Pair counts condition on one previous state. They estimate $P(\\text{next}\\mid\\text{previous})$, a first-order model, whatever you call it.",
        rubric: { keyIdeas: ["pairs give one state of context", "first-order estimate"], commonFlaws: ["same information"] },
        difficulty: 3,
      },
      {
        stem: "A phone keyboard suggests the next word from counts of word triples in your messages. A triple you've never typed gets probability 0. What problem does this cause?",
        kind: "application", context: "novel", scenario: "keyboard autocomplete sparsity",
        options: [opt("zero", "Reasonable new phrases containing it get probability 0"), opt("sum", "The model's probabilities would no longer sum to exactly 1", "thinks zeros break normalisation"), opt("first", "It quietly turns the model into a first-order model", "confuses sparsity with reduced order"), opt("common", "Common phrases end up with a lower probability", "thinks zeros lower the frequent cases")],
        correct: "zero",
        explanation: "Under the chain rule, one zero factor makes the whole sequence probability 0. This is the sparsity problem, and it gets worse as the order grows. Smoothing reserves some probability for unseen continuations.",
        rubric: { keyIdeas: ["zero factor makes whole product zero", "unseen ≠ impossible"], commonFlaws: ["probabilities don't sum to one"] },
        difficulty: 3,
      },
    ],
    reasoning: {
      sound: /context|count of (the )?(pair|context)|divide by (the )?(number|count) of (times )?(b,? ?a|the context)|occurr|split|fewer/i,
      flawed: /sequence length|all (the )?triples|twice/i,
      misconception: { label: "normalises over the wrong set when counting", description: "Divides by the total number of items or triples rather than by occurrences of the conditioning context." },
    },
  },
];

export const BY_SLUG = new Map(CURRICULUM.map((c) => [c.slug, c]));

export { slugify };

/** Fixture lookup tolerant of the names an analysis might use. */
export function findFixture(name: string): FixtureConcept | undefined {
  const s = slugify(name);
  return BY_SLUG.get(s) ?? CURRICULUM.find((c) => slugify(c.name) === s);
}
