import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answeredText, readQuestions } from '../src/questionCard';

test("Claude's questions are read from the tool's input, and anything else is not taken for them", () => {
  const questions = readQuestions({
    questions: [
      { question: 'Which fruit?', header: 'Fruit', multiSelect: false, options: [{ label: 'Apple', description: 'Crisp', preview: 'sketch' }, { label: 'Banana' }, { description: 'no label' }] },
      { question: 'Which extras?', options: [{ label: 'Nuts', description: '' }], multiSelect: true },
    ],
  });
  assert.deepEqual(questions, [
    { question: 'Which fruit?', header: 'Fruit', multiSelect: false, options: [{ label: 'Apple', description: 'Crisp', preview: 'sketch' }, { label: 'Banana', description: '' }] },
    { question: 'Which extras?', header: '', multiSelect: true, options: [{ label: 'Nuts', description: '' }] },
  ]);
  for (const input of [{}, { questions: [] }, { questions: 'Which?' }, { questions: [{ options: [] }] }, { questions: [{ question: 'Which?' }] }]) {
    assert.equal(readQuestions(input as Record<string, unknown>), null);
  }
});

test('an answered card names each question by its label, or its text when it has none', () => {
  const questions = readQuestions({ questions: [{ question: 'Which fruit?', header: 'Fruit', options: [] }, { question: 'Which extras?', options: [] }] }) ?? [];
  assert.equal(answeredText(questions, { 'Which fruit?': 'Banana', 'Which extras?': 'Nuts, Honey' }), 'Fruit → Banana · Which extras? → Nuts, Honey');
});
