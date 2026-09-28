// Two grammars highlight.js does not have, for NEURON, the simulator many neuroscience papers
// publish models for: NMODL (.mod, the mechanisms) and hoc (.hoc, .ses, the interpreter's
// language). Small on purpose: keywords, comments, strings, numbers, and the names of what a
// file defines.
import type { HLJSApi, Language } from "highlight.js";

/** NMODL: blocks in capitals (NEURON { … }, PARAMETER { … }), ":" and "?" comments, and
 *  COMMENT … ENDCOMMENT; C between VERBATIM and ENDVERBATIM. */
export function nmodl(hljs: HLJSApi): Language {
  return {
    name: "NMODL",
    aliases: ["mod"],
    keywords: {
      keyword:
        "NEURON SUFFIX POINT_PROCESS ARTIFICIAL_CELL USEION READ WRITE VALENCE REPRESENTS RANGE GLOBAL NONSPECIFIC_CURRENT " +
        "ELECTRODE_CURRENT POINTER BBCOREPOINTER RANDOM THREADSAFE EXTERNAL UNITS PARAMETER ASSIGNED STATE BREAKPOINT SOLVE " +
        "METHOD STEADYSTATE INITIAL DERIVATIVE KINETIC LINEAR NONLINEAR PROCEDURE FUNCTION FUNCTION_TABLE NET_RECEIVE CONSTANT " +
        "INDEPENDENT TABLE DEPEND FROM TO WITH LOCAL CONSERVE COMPARTMENT LONGITUDINAL_DIFFUSION WATCH FOR_NETCONS INCLUDE " +
        "DEFINE PROTECT MUTEXLOCK MUTEXUNLOCK UNITSON UNITSOFF TITLE if else while for",
      built_in:
        "exp log log10 sin cos tan atan atan2 sqrt fabs pow tanh sinh cosh floor ceil fmod erf erfc net_send net_event " +
        "net_move nrn_random_play printf scop_random exprand normrand at_time celsius v t dt area diam",
      literal: "cnexp derivimplicit euler runge sparse after_cvode cvode_t",
    },
    contains: [
      hljs.COMMENT(/^\s*COMMENT\b/, /^\s*ENDCOMMENT\b/),
      hljs.COMMENT(/:/, /$/),
      hljs.COMMENT(/\?/, /$/),
      { scope: "meta", begin: /^\s*(?:VERBATIM|ENDVERBATIM)\b/ },
      { scope: "section", begin: /^\s*TITLE\b/, end: /$/ },
      {
        match: [/\b(?:PROCEDURE|FUNCTION|DERIVATIVE|KINETIC|LINEAR|NONLINEAR|FUNCTION_TABLE)\s+/, /[A-Za-z_]\w*/],
        scope: { 1: "keyword", 2: "title.function" },
      },
      { scope: "operator", begin: /~|<->|->/ },
      hljs.QUOTE_STRING_MODE,
      hljs.C_NUMBER_MODE,
    ],
  };
}

/** hoc: C-like, with procedures (`proc`, `func`, `obfunc`), templates, sections and the
 *  interpreter's built-in objects. */
export function hoc(hljs: HLJSApi): Language {
  return {
    name: "hoc",
    aliases: ["ses"],
    keywords: {
      keyword:
        "proc func obfunc iterator iterator_statement begintemplate endtemplate public external objref objectvar strdef " +
        "double create access connect insert uninsert forall forsec ifsec if else while for break continue return stop " +
        "local localobj new print read setpointer delete_section",
      built_in:
        "xopen load_file load_proc load_func nrn_load_dll printf sprintf fprint psection topology finitialize fadvance run " +
        "init continuerun stdinit tstop dt t v celsius secname sectionname pop_section push_section xpanel xbutton xvalue " +
        "xlabel xmenu xradiobutton define_shape distance area ri Vector Graph List File Random Matrix SectionList SectionRef " +
        "NetCon NetStim IClamp VClamp SEClamp APCount Impedance CVode ParallelContext PlotShape Shape",
      literal: "PI E GAMMA DEG FARADAY R nil",
    },
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      hljs.QUOTE_STRING_MODE,
      hljs.C_NUMBER_MODE,
      {
        match: [/\b(?:proc|func|obfunc|iterator|begintemplate|endtemplate)\s+/, /[A-Za-z_]\w*/],
        scope: { 1: "keyword", 2: "title.function" },
      },
    ],
  };
}
