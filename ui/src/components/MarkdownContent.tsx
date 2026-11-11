import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function isSafeHref(href: string | undefined): boolean {
    if (!href) {
        return false;
    }
    try {
        const url = new URL(href, window.location.origin);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

const components: Components = {
    a({ href, children }) {
        if (!isSafeHref(href)) {
            return <span>{children}</span>;
        }
        return (
            <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
            </a>
        );
    },
    table({ children }) {
        return (
            <div className="md-table-wrap">
                <table>{children}</table>
            </div>
        );
    },
    pre({ children }) {
        return <pre className="md-pre">{children}</pre>;
    },
    code({ className, children, ...props }) {
        const isBlock = Boolean(className);
        if (isBlock) {
            return (
                <code className={className} {...props}>
                    {children}
                </code>
            );
        }
        return (
            <code className="md-inline-code" {...props}>
                {children}
            </code>
        );
    },
};

interface MarkdownContentProps {
    content: string;
}

export function MarkdownContent({ content }: MarkdownContentProps) {
    return (
        <div className="md-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {content}
            </ReactMarkdown>
        </div>
    );
}
