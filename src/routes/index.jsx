import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const slides = ["Requirement → Schema", "Natural Language → Query", "Query Lab"];

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "DBMentor — Describe it, watch it wire up" },
      {
        name: "description",
        content:
          "DBMentor turns plain-English requirements into database schemas, ER diagrams and runnable SQL.",
      },
      { property: "og:title", content: "DBMentor — Describe it, watch it wire up" },
      {
        property: "og:description",
        content: "Turn a sentence of requirements into a schema, an ER diagram and runnable SQL.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  const [activeSlide, setActiveSlide] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setActiveSlide((current) => (current + 1) % slides.length);
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#164a41] text-[#fffdf7]">
      <div className="dotgrid pointer-events-none absolute inset-0 opacity-35" />

      <header className="relative border-b border-[#9dc88d]/20 bg-[#123b35]/85 backdrop-blur-md">
        <div className="mx-auto flex h-20 max-w-6xl items-center justify-between px-6 lg:max-w-none">
          <div className="flex items-center gap-2.5">
            <div className="grid size-7 place-items-center rounded-[9px] bg-[#f1b24a] ring-1 ring-inset ring-[#fffdf7]/40">
              <span className="font-mono text-[16.9px] font-semibold text-[#164a41]">◍</span>
            </div>
            <span className="font-mono text-[18.2px] font-semibold tracking-tight text-[#fffdf7]">DBMentor</span>
          </div>
          <nav className="hidden items-center gap-3 md:flex">
            <Link
              to="/workspace"
              className="landing-button inline-flex items-center px-[15px] py-[7.5px] font-mono text-[18.1px] font-semibold transition-transform hover:-translate-y-px hover:bg-[#ffd06a]"
            >
              Schema
            </Link>
            <Link
              to="/query-lab"
              className="landing-button inline-flex items-center px-[15px] py-[7.5px] font-mono text-[18.1px] font-semibold transition-transform hover:-translate-y-px hover:bg-[#ffd06a]"
            >
              Query Lab
            </Link>
            <Link
              to="/nl-query"
              className="landing-button inline-flex items-center px-[15px] py-[7.5px] font-mono text-[18.1px] font-semibold transition-transform hover:-translate-y-px hover:bg-[#ffd06a]"
            >
              NL → Query
            </Link>
          </nav>
        </div>
      </header>

      <section className="relative mx-auto grid max-w-6xl grid-cols-1 items-start gap-10 px-6 pb-16 pt-16 md:grid-cols-12 lg:max-w-none lg:grid-cols-[minmax(0,1fr)_minmax(0,46ch)] lg:justify-between lg:px-16">
        <div className="max-w-[40ch] md:col-span-6 lg:col-span-1">
          <h1 className="mt-0 text-balance text-[3.0rem] font-semibold leading-[0.88] tracking-[-0.06em] text-[#fffdf7] md:text-[5rem]">
            Describe it.
            <br />
            And <span className="text-[#9dc88d]">DBMentor</span>
            <br />
            Will Build It.
          </h1>
          <p className="mt-14 max-w-[46ch] text-pretty text-[20.8px] leading-relaxed text-[#e7efe4] md:text-[22.1px]">
            DBMentor turns your sentence of requirements into a schema with an ER diagram and a runnable SQL query.
            Then a step-by-step story of exactly how Postgres executes it — so you learn the
            reasoning, not just the syntax.
          </p>
        </div>

        <div className="w-full md:col-span-6 lg:col-span-1 lg:max-w-[46ch] lg:translate-y-8 lg:justify-self-end">
          <div className="relative overflow-hidden rounded-[24px] border border-[#9dc88d]/35 bg-[linear-gradient(135deg,#4d774e_0%,#7ba96c_100%)] p-4 shadow-[0_20px_60px_rgba(0,0,0,0.25)] lg:-ml-[170px] lg:w-[calc(100%_+_170px)]">
            <div className="mb-4 flex items-center justify-between px-1">
              <span className="font-mono text-[14px] font-medium text-[#fffdf7]">{slides[activeSlide]}</span>
              <div className="flex gap-1.5">
                <span className="size-3 rounded-full bg-[#164a41]" />
                <span className="size-3 rounded-full bg-[#9dc88d]" />
                <span className="size-3 rounded-full bg-[#f1b24a]" />
              </div>
            </div>

            <div className="dotgrid relative h-[380px] overflow-hidden rounded-[18px] bg-[#163a33] p-4 ring-1 ring-inset ring-[#f1b24a]/35">
              {activeSlide === 0 && (
                <>
                  <div className="absolute left-[24%] top-[124px] h-px w-[18%] rotate-[12deg] bg-[#9dc88d]" />
                  <div className="absolute left-[58%] top-[206px] h-px w-[18%] -rotate-[8deg] bg-[#f1b24a]" />
                  <div className="absolute left-3 top-4 w-[clamp(112px,20%,168px)] overflow-hidden rounded-[10px] bg-[#4d774e] ring-1 ring-inset ring-[#fffdf7]/35">
                    <div className="bg-[#5b8758] px-3 py-2 font-mono text-[14px] font-semibold text-[#fffdf7]">customers</div>
                    <div className="divide-y divide-[#fffdf7]/20 px-3 pb-1 font-mono text-[13px] leading-relaxed text-[#fffdf7]">
                      <div className="py-0.5">id</div><div className="py-0.5">email</div><div className="py-0.5">name</div>
                    </div>
                  </div>
                  <div className="absolute left-1/2 top-[40%] w-[clamp(112px,20%,168px)] -translate-x-1/2 overflow-hidden rounded-[10px] bg-[#9dc88d] ring-1 ring-inset ring-[#164a41]/25">
                    <div className="bg-[#b8e3a5] px-3 py-2 font-mono text-[14px] font-semibold text-[#164a41]">orders</div>
                    <div className="divide-y divide-[#164a41]/20 px-3 pb-1 font-mono text-[13px] leading-relaxed text-[#164a41]">
                      <div className="py-0.5">id</div><div className="py-0.5">customer_id</div><div className="py-0.5">total</div>
                    </div>
                  </div>
                  <div className="absolute right-3 top-4 w-[clamp(112px,20%,168px)] overflow-hidden rounded-[10px] bg-[#f1b24a] ring-1 ring-inset ring-[#164a41]/25">
                    <div className="bg-[#ffd06a] px-3 py-2 font-mono text-[14px] font-semibold text-[#164a41]">products</div>
                    <div className="divide-y divide-[#164a41]/20 px-3 pb-1 font-mono text-[13px] leading-relaxed text-[#164a41]">
                      <div className="py-0.5">id</div><div className="py-0.5">sku</div><div className="py-0.5">price</div>
                    </div>
                  </div>
                </>
              )}
              {activeSlide === 1 && (
                <div className="flex h-full flex-col items-stretch justify-center gap-4 md:flex-row md:items-center">
                  <div className="flex-1 rounded-[12px] bg-[#4d774e] p-4 ring-1 ring-inset ring-[#fffdf7]/30">
                    <div className="mb-3 font-mono text-[11px] uppercase text-[#b8e3a5]">Ask in plain English</div>
                    <p className="text-[16px] leading-relaxed text-[#fffdf7]">List customers with their latest orders.</p>
                  </div>
                  <div className="self-center font-mono text-[22px] text-[#ffd06a]">→</div>
                  <div className="min-w-0 flex-1 rounded-[12px] bg-[#f1b24a] p-4 text-[#164a41] ring-1 ring-inset ring-[#fffdf7]/30">
                    <div className="mb-3 font-mono text-[11px] uppercase">SQL</div>
                    <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed">{"SELECT c.name, o.placed_at\nFROM customers c\nJOIN orders o\n  ON o.customer_id = c.id;"}</pre>
                  </div>
                </div>
              )}
              {activeSlide === 2 && (
                <div className="flex h-full flex-col gap-3 font-mono text-[11px]">
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-[#214e43] ring-1 ring-inset ring-[#9dc88d]/40">
                    <div className="border-b border-[#9dc88d]/25 px-3 py-2 text-[#b8e3a5]">SQL Query</div>
                    <pre className="overflow-hidden whitespace-pre-wrap p-3 leading-relaxed text-[#fffdf7]">{"SELECT name, total\nFROM customers\nJOIN orders ON customer_id = id;"}</pre>
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden rounded-[10px] bg-[#fffdf7] text-[#164a41] ring-1 ring-inset ring-[#f1b24a]/60">
                    <div className="border-b border-[#164a41]/15 px-3 py-2">Results · 3 rows</div>
                    <div className="grid grid-cols-3 gap-x-3 gap-y-1 px-3 py-2 text-[10px]">
                      <span className="font-semibold">name</span><span className="font-semibold">total</span><span className="font-semibold">status</span>
                      <span>Ada</span><span>120</span><span>paid</span><span>Sam</span><span>85</span><span>open</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 lg:-ml-[170px] lg:w-[calc(100%_+_170px)]">
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="DBMentor workflow previews">
              {slides.map((slide, index) => (
                <button
                  key={slide}
                  type="button"
                  role="tab"
                  aria-selected={activeSlide === index}
                  onClick={() => setActiveSlide(index)}
                  className={`rounded-[8px] px-2.5 py-1.5 font-mono text-[12px] transition-colors ${activeSlide === index ? "bg-[#ffd06a] text-[#164a41]" : "bg-[#123b35] text-[#e7efe4] hover:bg-[#4d774e]"}`}
                >
                  {slide}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button type="button" aria-label="Previous preview" onClick={() => setActiveSlide((activeSlide + slides.length - 1) % slides.length)} className="grid size-9 place-items-center rounded-[8px] bg-[#123b35] text-[#fffdf7] hover:bg-[#4d774e]">
                <ChevronLeft size={17} />
              </button>
              <button type="button" aria-label="Next preview" onClick={() => setActiveSlide((activeSlide + 1) % slides.length)} className="grid size-9 place-items-center rounded-[8px] bg-[#123b35] text-[#fffdf7] hover:bg-[#4d774e]">
                <ChevronRight size={17} />
              </button>
            </div>
          </div>
          <div className="mt-6 flex justify-center lg:-ml-[170px] lg:w-[calc(100%_+_170px)]">
            <Link
              to="/workspace"
              className="landing-button inline-flex w-full items-center justify-center px-6 py-4 font-mono text-[22.1px] font-semibold transition-transform hover:-translate-y-px hover:bg-[#ffd06a] lg:w-3/4"
            >
              Let's Get Started
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
