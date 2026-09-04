import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  // Links open in a new tab; `node` is react-markdown's AST handle, not a DOM prop.
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
