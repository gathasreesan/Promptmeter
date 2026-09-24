"""PromptMeter dataset audit and conservative augmentation.

Default: audit phrases.csv without changing it.
Optional: --augment produces a separate training-only CSV with limited, clearly
marked synthetic examples. NEVER mix synthetic examples into evaluation data.

The four labels describe *phrases/spans*, not necessarily whole prompts. A full
prompt containing a task and a greeting should be segmented before classification.
"""
import argparse
import csv
import random
import re
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
LABELS = ('IMPORTANT', 'FILLER', 'REDUNDANT', 'REPETITIVE')
# Distinct formulations, not combinatorial recombinations of the original seed.
# Synthetic rows are intentionally few and must not be treated as held-out data.
SYNTHETIC = {
    'IMPORTANT': [
        'pls compare {topic} with a concrete example',
        'I am stuck on {topic}; show me how to solve a practice question',
        'Explain {topic} in three sentences, no jargon',
    ],
    'FILLER': [
        'hey, I was reading about {topic} earlier, just saying hi',
        'I had a long day learning {topic}; good night',
    ],
    'REDUNDANT': [
        'I would like to kindly request that you please discuss {topic}',
        'for the purpose of being able to understand {topic}',
    ],
    'REPETITIVE': [
        'explain {topic}, explain {topic} again, explain {topic}',
        'tell me about {topic}; tell me about {topic} once more',
    ],
}
TOPICS = ['recursion', 'SQL joins', 'graph traversal', 'PCA', 'HTTP caching',
          'unit testing', 'binary search', 'database indexing', 'tokenization']

def normalize(text):
    return re.sub(r'\s+', ' ', text).strip().casefold()

def read_rows(path):
    with path.open(newline='', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames or not {'text', 'label'} <= set(reader.fieldnames):
            raise ValueError('CSV must contain text and label columns')
        return [{ 'text': (r.get('text') or '').strip(),
                  'label': (r.get('label') or '').strip().upper(),
                  'source': (r.get('source') or 'unknown').strip()}
                for r in reader]

def audit(rows):
    counts = Counter(r['label'] for r in rows)
    sources = Counter(r['source'] for r in rows)
    seen = defaultdict(set)
    blank = []
    for i, r in enumerate(rows, 2):
        if not r['text'] or r['label'] not in LABELS:
            blank.append(i)
        if r['text']:
            seen[normalize(r['text'])].add(r['label'])
    normalized_counts = Counter(normalize(r['text']) for r in rows if r['text'])
    dupes = sum(n - 1 for n in normalized_counts.values() if n > 1)
    conflicts = {k: sorted(v) for k, v in seen.items() if len(v) > 1}
    print('Rows:', len(rows))
    print('By label:', dict(counts))
    print('By source:', dict(sources))
    print('Duplicate normalized texts:', dupes)
    print('Conflicting labels:', len(conflicts))
    print('Blank/invalid rows:', blank[:20])
    if conflicts:
        for text, labels in list(conflicts.items())[:10]:
            print('REVIEW:', repr(text), labels)
    print('Manual label review recommended: standalone constraints or multiple'
          ' distinct requirements are often IMPORTANT, not REPETITIVE.')
    return not blank and not conflicts

def augment(rows, per_class, seed):
    rng = random.Random(seed)
    seen = {normalize(r['text']) for r in rows}
    out = list(rows)
    for label in LABELS:
        candidates = [template.format(topic=topic)
                      for template in SYNTHETIC[label] for topic in TOPICS]
        rng.shuffle(candidates)
        added = 0
        for text in candidates:
            key = normalize(text)
            if key not in seen:
                out.append({'text': text, 'label': label, 'source': 'synthetic'})
                seen.add(key)
                added += 1
            if added >= per_class:
                break
        print(f'{label}: +{added} synthetic training-only rows')
    return out

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=HERE/'phrases.csv')
    parser.add_argument('--augment', action='store_true',
                        help='write separate training-only augmented dataset')
    parser.add_argument('--output', type=Path,
                        default=HERE/'phrases_train_augmented.csv')
    parser.add_argument('--per-class', type=int, default=10)
    parser.add_argument('--seed', type=int, default=20260924)
    args = parser.parse_args()
    if args.per_class < 0 or args.per_class > 20:
        parser.error('--per-class must be between 0 and 20')
    if args.input.resolve() == args.output.resolve():
        parser.error('input and output must differ; never overwrite source data')
    rows = read_rows(args.input)
    if not audit(rows):
        parser.error('fix invalid or conflicting rows before augmentation')
    if not args.augment:
        print('Audit only: no file changed. Add --augment to write training data.')
        return
    result = augment(rows, args.per_class, args.seed)
    with args.output.open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['text', 'label', 'source'])
        writer.writeheader()
        writer.writerows(result)
    print('Wrote', args.output, 'rows:', len(result))
    print('IMPORTANT: split/evaluate on seed or independently collected human data;'
          ' do not report synthetic rows as real held-out examples.')

if __name__ == '__main__':
    main()
