// Claude's multiple-choice questions (its AskUserQuestion tool), answered in the chat. Claude Code
// hands them to the panel as a permission request; the answers go back as the tool's input, keyed
// by each question's text, which is how Claude Code itself returns them.

export interface QuestionOption {
  label: string;
  description: string;
  /** Shown while the option is chosen: a sketch or a snippet to compare options by. */
  preview?: string;
}

export interface Question {
  question: string;
  /** A short label for the question, shown above it. */
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** The questions of an AskUserQuestion request; null when the input is not one. */
export function readQuestions(input: Record<string, unknown>): Question[] | null {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: Question[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (typeof item?.question !== 'string' || !Array.isArray(item.options)) return null;
    const options = (item.options as Record<string, unknown>[])
      .filter((option) => typeof option?.label === 'string')
      .map((option) => ({
        label: option.label as string,
        description: typeof option.description === 'string' ? option.description : '',
        ...(typeof option.preview === 'string' && option.preview ? { preview: option.preview } : {}),
      }));
    questions.push({ question: item.question, header: typeof item.header === 'string' ? item.header : '', options, multiSelect: item.multiSelect === true });
  }
  return questions;
}

/** What the card says once answered: each question's short label (or text) and its answer. */
export function answeredText(questions: Question[], answers: Record<string, string>): string {
  return questions.map((question) => `${question.header || question.question} → ${answers[question.question] ?? ''}`).join(' · ');
}

/**
 * Draws `questions` into `card`: each with its options as buttons (several may be picked when the
 * question allows it) and a box for an answer of your own. A single question with one answer, and
 * no previews to read, is answered by its click; otherwise Send sends once every question has an answer. `done` gets the
 * answers by question text (several picks joined by commas, as Claude Code joins them), or null
 * when the questions are skipped.
 */
export function renderQuestionCard(card: HTMLElement, questions: Question[], done: (answers: Record<string, string> | null) => void): void {
  card.addClass('vc-question-card');
  card.createDiv({ cls: 'vc-permission-title', text: questions.length === 1 ? 'Claude has a question' : `Claude has ${questions.length} questions` });
  // Options with a preview are picked first, so that the preview can be read, and then sent.
  const instant = questions.length === 1 && !questions[0].multiSelect && !questions[0].options.some((option) => option.preview);
  const picked = questions.map(() => new Set<string>());
  const typed = questions.map(() => '');
  const answer = (index: number): string => {
    const question = questions[index];
    const own = typed[index].trim();
    if (!question.multiSelect) return own || [...picked[index]][0] || '';
    return [...question.options.map((option) => option.label).filter((label) => picked[index].has(label)), ...(own ? [own] : [])].join(', ');
  };
  let send: HTMLButtonElement | null = null;
  const complete = () => questions.every((_, index) => answer(index) !== '');
  const finish = () => {
    if (!complete()) return;
    done(Object.fromEntries(questions.map((question, index) => [question.question, answer(index)])));
  };
  questions.forEach((question, index) => {
    const block = card.createDiv({ cls: 'vc-question' });
    if (question.header) block.createDiv({ cls: 'vc-question-header', text: question.header });
    block.createDiv({ cls: 'vc-question-text', text: question.question });
    if (question.multiSelect) block.createDiv({ cls: 'vc-muted vc-question-hint', text: 'Pick any that apply.' });
    const list = block.createDiv({ cls: 'vc-question-options' });
    const preview = block.createEl('pre', { cls: 'vc-question-preview' });
    preview.hide();
    const buttons: HTMLButtonElement[] = [];
    const refresh = () => {
      question.options.forEach((option, i) => {
        const on = picked[index].has(option.label) && (question.multiSelect || !typed[index].trim());
        buttons[i].toggleClass('is-picked', on);
        buttons[i].setAttr('aria-pressed', String(on));
      });
      const shown = question.options.find((option) => option.preview && picked[index].has(option.label));
      preview.setText(shown?.preview ?? '');
      preview.toggle(shown !== undefined);
      send?.toggleClass('is-ready', complete());
      if (send) send.disabled = !complete();
    };
    question.options.forEach((option) => {
      const button = list.createEl('button', { cls: 'vc-question-option' });
      button.createSpan({ cls: 'vc-question-label', text: option.label });
      if (option.description) button.createSpan({ cls: 'vc-question-description', text: option.description });
      button.addEventListener('click', () => {
        if (question.multiSelect) {
          if (picked[index].has(option.label)) picked[index].delete(option.label);
          else picked[index].add(option.label);
        } else {
          picked[index] = new Set([option.label]);
          typed[index] = '';
          own.value = '';
        }
        refresh();
        if (instant) finish();
      });
      buttons.push(button);
    });
    const own = block.createEl('input', { cls: 'vc-question-own', attr: { type: 'text', placeholder: 'Or type an answer of your own' } });
    own.addEventListener('input', () => {
      typed[index] = own.value;
      refresh();
    });
    own.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Enter' || evt.isComposing) return;
      evt.preventDefault();
      finish();
    });
  });
  const actions = card.createDiv({ cls: 'vc-permission-buttons' });
  send = actions.createEl('button', { cls: 'mod-cta', text: 'Send' });
  send.disabled = true;
  send.addEventListener('click', finish);
  actions.createEl('button', { text: 'Skip' }).addEventListener('click', () => done(null));
}
