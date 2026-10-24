/** Models the app can benchmark without HolaHub. HolaHub's copy of a config wins whenever it loads. */
export const BUNDLED_BENCH_SUBJECTS: ReadonlyArray<
  Record<string, unknown> & { id: string; name: string; vendor?: string; quant: string }
> = [
  {
    type: "model",
    id: "openbmb-minicpm5-2b",
    name: "MiniCPM5-2B",
    vendor: "OpenBMB",
    quant: "Q4_K_M",
    ollama: {
      tag: "openbmb/minicpm5-2b:q4_K_M",
      known_digests: ["71a44e98400fbd490d66332a0ebba31143479a714987c13f45c82e94025cbfa7"],
    },
    sampling: { temperature: 1.0, top_p: 0.95, min_p: 0 },
    suites: ["suite-standard@1.0"],
  },
];
