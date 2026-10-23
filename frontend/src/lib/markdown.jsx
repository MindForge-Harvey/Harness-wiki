import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 回答与卡片正文的 Markdown 渲染：GFM（表格/任务列表）+ 图片原样输出。
 * 图片 URL 由 dsh-knowledge 注入（http://127.0.0.1:3090/kb/image?...），浏览器直连子进程。
 * 表格外包横向滚动容器：单元格长文本按内容分配列宽，超出部分横向滚动，避免被压成一字一行的竖排。
 */
export function Markdown({ children, className = "" }) {
  return (
    <div className={`chat-md${className ? ` ${className}` : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ node, children, ...props }) => {
            const content = node.children.filter(child => child.type !== "text" || child.value.trim());
            const sectionTitle = content.length === 1 && content[0].type === "element" && content[0].tagName === "strong";
            return <p {...props} className={sectionTitle ? "md-section-title" : undefined}>{children}</p>;
          },
          table: (props) => (
            <div className="md-table-wrap">
              <table {...props} />
            </div>
          ),
          // 引用角标：回答里的 [[文件名]] 已转成 #cite- 链接，渲染为上标并跳到对应来源项。
          // 页面有 <base href>，纯锚点会被解析成根路径触发整页跳转，因此拦截点击手动滚动。
          a: ({ node, href, children, ...props }) => {
            if (href && href.startsWith("#cite-")) {
              return (
                <sup className="md-cite">
                  <a
                    href={href}
                    {...props}
                    onClick={(event) => {
                      event.preventDefault();
                      const target = document.getElementById(href.slice(1));
                      if (!target) return;
                      target.scrollIntoView({ behavior: "smooth", block: "center" });
                      target.classList.remove("cite-flash");
                      void target.offsetWidth; // 重置动画：连续点击同一角标也能重新高亮
                      target.classList.add("cite-flash");
                    }}
                  >[{children}]</a>
                </sup>
              );
            }
            return <a href={href} {...props}>{children}</a>;
          },
        }}
      >
        {children || ""}
      </ReactMarkdown>
    </div>
  );
}
