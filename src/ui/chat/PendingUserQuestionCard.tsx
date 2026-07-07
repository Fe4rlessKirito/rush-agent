interface PendingUserQuestionCardProps {
  question: string;
  choices: Array<{ label: string; value: string; description: string }>;
  answer: string;
  busy: boolean;
  setAnswer: (answer: string) => void;
  submitAnswer: (answer: string) => void;
}

export function PendingUserQuestionCard({
  question,
  choices,
  answer,
  busy,
  setAnswer,
  submitAnswer,
}: PendingUserQuestionCardProps) {
  return (
    <div className="ask-user-card">
      <div className="ask-user-card-head">
        <strong>Rush needs your input</strong>
        <span>Answer to continue</span>
      </div>
      <p>{question}</p>
      {choices.length > 0 && (
        <div className="ask-user-choices">
          {choices.map((choice, index) => (
            <button type="button" key={`${choice.value}:${index}`} onClick={() => submitAnswer(choice.value)}>
              <span>{choice.label}</span>
              {choice.description && <small>{choice.description}</small>}
            </button>
          ))}
        </div>
      )}
      <form
        className="ask-user-form"
        onSubmit={(event) => {
          event.preventDefault();
          submitAnswer(answer);
        }}
      >
        <input
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder="Type an answer..."
        />
        <button type="submit" disabled={!answer.trim() || busy}>Send answer</button>
      </form>
    </div>
  );
}
