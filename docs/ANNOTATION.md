# Labelling the classification sample

This guide is for the owner. It explains how to fill `sample.csv`, the 150 papers that decide
how OSCR classifies papers (decisions D6 and D7 of 2026-09-27).

## Why

OSCR harvests broadly and filters by classification: a paper judged off-topic stays on the Mac,
out of the site and out of the statistics (D7). Rules classify first; a local model settles only
the cases the rules leave ambiguous (D6). Before a model is chosen, two or three of them are
compared, with the rules, on papers **you** have labelled by hand. Your labels are the reference:
nothing is scored against anything else.

## Where the file is, and where it stays

- The file: `/Volumes/Expansion/Scrapper/data/annotation/sample.csv`.
- It holds titles and abstracts, so it **stays on the Mac**: it is under `data/`, which is never
  versioned, never uploaded, never published.
- Next to it, `rules_predictions.csv` holds what the rules answered. **Do not open it before you
  have finished**: seeing the rules' answers would bias your labels, and the evaluation with them.
- Open `sample.csv` with Numbers or Excel. Then save it **as CSV, in UTF-8, under the same name
  and in the same place** (Numbers: File > Export To > CSV, text encoding Unicode (UTF-8), then
  replace the file). Do not reorder, rename or delete columns, and keep the `id` column as it is.

## What to read

Each row gives `title`, `journal`, `year`, `type` (the article type), `keywords` and the start of
the `abstract` (at most 1,500 characters). `url` opens the paper when the abstract is not enough:
the methods of a paper often settle its modality. The rows are in random order.

## What to write

Six columns are yours: `on_topic`, `modality`, `organism`, `population`, `subfield`, `notes`.

- **One value, or several separated by "; "** (a semicolon and a space): `eeg; fmri`.
  `modality`, `organism` and `population` take several values; `on_topic` and `subfield` take one.
- Use the value identifiers in the tables below (`structural_mri`, `nhp`...). The names and common
  abbreviations are also understood (`EEG`, `Alzheimer's`, `mouse`, `MS`), whatever the case.
- **Unsure: write `?`** (alone, or after a guess: `eeg; ?`) and say why in `notes`. A cell with
  `?` is not scored: that is better than a guess.
- **Not applicable: write `-`**. For example, `population` for a pure simulation, which has no
  subjects.
- **Empty means "not done yet"**. For a paper that is off-topic, `on_topic` = `no` is enough; the
  other columns may stay empty.
- `notes` is free text: a doubt, a remark about the vocabulary ("this needs a value for X"), a
  paper that should not be in the sample.
- A value outside the vocabulary is reported by the comparison tool and not scored; nothing breaks.

## How long it takes

About one minute per paper, less for an off-topic one: **2 to 3 hours in all**. It can be done
in several sittings of 30 to 50 papers. The comparison refuses to run until at least 80% of the
rows have their `on_topic` filled.

## `on_topic`: what "neuroscience" means here

**Neuroscience means research on the nervous system, or research on the mind that uses neural
measures.**

- The nervous system: the brain, the spinal cord, the nerves, the retina, and the sensory organs'
  neurons; their cells, circuits, chemistry, development, diseases and treatments. A clinical study
  of a nervous-system disease is on topic even without a neural measure (a trial of an antiseizure
  drug with seizure counts only: `yes`).
- The mind (perception, cognition, emotion, behavior, mental illness) counts **only with neural
  measures**: EEG, MEG, MRI, PET, fNIRS, recordings, lesions, brain stimulation, neural tissue.
  Psychology or psychiatry with questionnaires and behavior only is `no`.
- Not neuroscience: papers where "neural" only means an artificial neural network, where "cortex"
  is the cortex of a bone, a kidney or a plant, and papers that name the brain once in passing.

Borderline cases, and the answer the definition gives (write `?` and a note if you disagree: the
definition can change, and your notes are how it changes):

| case | answer |
|---|---|
| deep learning on EEG, MRI or neural recordings | `yes` |
| deep learning ("neural networks") on anything else | `no` |
| depression or anxiety measured with questionnaires only | `no` |
| a psychiatric drug trial with symptom scales only | `no` |
| the same trial with EEG or MRI | `yes` |
| stroke, epilepsy, multiple sclerosis, migraine: clinical outcomes only | `yes` (nervous-system diseases) |
| brain tumors and brain metastases, their treatment | `yes` |
| a cancer outside the nervous system, even when the brain is mentioned | `no` |
| the retina and the optic nerve; hearing and the auditory nerve | `yes` |
| the eye's lens or cornea; the middle ear | `no` |
| peripheral nerves, the vagus nerve, the enteric nervous system | `yes` |
| a nerve block for surgical anesthesia | `?` and a note (your call) |
| teaching or education about the brain, without neural research | `no` |
| neurotechnology: an electrode, an implant, a neural interface | `yes` |
| a neuromorphic chip or an artificial synapse made of materials | `no` |

## The other facets

The tables give each value's identifier, its meaning and invented examples.

### `modality`: the data the paper collects or analyses

List every modality that is a real part of the work, not those only mentioned in the background.
For a review, the kind of data it discusses. "Behavior only" and "computational modeling (no new
data)" apply only when there is no neural recording or imaging.

| value | meaning | examples |
|---|---|---|
| `eeg` (EEG) | Scalp electroencephalography, including event-related potentials (ERP) and sleep EEG. | resting-state EEG in older adults; a P300 oddball ERP study; sleep spindles in overnight EEG |
| `meg` (MEG) | Magnetoencephalography (SQUID or optically pumped magnetometers). | MEG source imaging of auditory responses; OPM-MEG in children |
| `fmri` (fMRI) | Functional MRI (BOLD), task or resting state. | task fMRI of reward anticipation; resting-state functional connectivity in adolescents |
| `structural_mri` (structural MRI / diffusion) | MRI other than BOLD fMRI: anatomical (T1, T2, FLAIR), diffusion (DTI, tractography), perfusion, spectroscopy, quantitative MRI, clinical MRI reading. | cortical thickness in schizophrenia; DTI tractography of the arcuate fasciculus; MRI lesion load in multiple sclerosis |
| `pet_spect` (PET / SPECT) | Positron emission tomography or single-photon emission tomography, including amyloid, tau, FDG and dopamine transporter scans. | amyloid PET in preclinical Alzheimer's disease; DaT-SPECT in parkinsonism |
| `fnirs` (fNIRS) | Functional near-infrared spectroscopy and diffuse optical tomography. | prefrontal fNIRS during a dual task; fNIRS hyperscanning of parent-child pairs |
| `ieeg` (intracranial EEG: iEEG, ECoG, SEEG) | Human intracranial recordings: electrocorticography (ECoG), stereo-EEG (SEEG), depth electrodes, including local field potentials from deep brain stimulation leads. | SEEG seizure-onset zones; ECoG high-gamma responses to speech; subthalamic beta activity recorded from DBS leads |
| `extracellular` (extracellular electrophysiology: units, LFP) | Extracellular recordings of single units, multi-unit activity or local field potentials, mostly in animals or in vitro (tetrodes, silicon probes, Neuropixels, microelectrode arrays); human microelectrode single units count here too. | Neuropixels recordings in mouse visual cortex; hippocampal place cells recorded with tetrodes; a microelectrode array of cultured neurons |
| `intracellular` (intracellular / patch clamp) | Intracellular recordings: patch clamp (whole-cell, voltage or current clamp), sharp electrodes, two-electrode voltage clamp. | whole-cell recordings in hippocampal slices; patch clamp of iPSC-derived neurons; voltage clamp of a channel expressed in oocytes |
| `optical` (optical imaging: calcium, voltage, 2-photon) | Optical imaging of neural activity: calcium or voltage imaging (one- or two-photon, widefield, miniscopes), fiber photometry, intrinsic signal imaging. | two-photon calcium imaging in mouse visual cortex; fiber photometry of dopamine release; light-sheet calcium imaging of the larval zebrafish brain |
| `behavior` (behavior only) | Behavioral, cognitive or psychological measures only (tasks, tests, psychophysics, eye tracking, questionnaires, rating scales), with no neural recording or imaging. | a psychophysics study of visual crowding; water-maze and open-field tests after a drug in rats; cognitive tests in older adults |
| `modeling` (computational modeling, no new data) | Computational modeling without new data: theory, simulations, models fitted to published data. | a spiking network model of working memory; a neural mass model of seizure onset; a normative theory of grid cells |
| `omics` (genetics / omics) | Genetics and omics: sequencing, genotyping, GWAS, transcriptomics (bulk, single-cell, spatial), proteomics, metabolomics, epigenomics. | single-nucleus RNA-seq of the human cortex; a genome-wide association study of migraine; a de novo variant found by exome sequencing |
| `histology` (histology / microscopy) | Histology and microscopy of tissue or cells: staining, immunohistochemistry, immunofluorescence, confocal or electron microscopy, tissue clearing, neuropathology. | immunohistochemistry of microglia after injury; electron microscopy of synapses; post-mortem tau neuropathology |
| `other` | Any other data: clinical records and outcomes, blood or CSF biomarkers, EMG and other physiology, brain stimulation outcomes (TMS, tDCS), CT, ultrasound, retinal imaging, molecular assays (western blot, ELISA, qPCR). | plasma neurofilament light in ALS; motor evoked potentials after TMS; a registry of stroke outcomes |

### `organism`: the species studied

Where the subjects, tissue, cells or data come from. For in vitro work, the species the cells come
from (human iPSC-derived neurons are `human`).

| value | meaning | examples |
|---|---|---|
| `human` | Humans: participants, patients, human tissue or human cells. | EEG in healthy adults; post-mortem human brain tissue; human iPSC-derived neurons |
| `mouse` | Mice, including transgenic lines and mouse cells. | 5xFAD mice; mouse visual cortex slices; primary mouse microglia |
| `rat` | Rats and rat cells. | Sprague-Dawley rats after brain injury; rat hippocampal cultures |
| `nhp` (non-human primate) | Non-human primates: macaques, marmosets and other monkeys. | single units in macaque prefrontal cortex; marmoset vocal communication |
| `zebrafish` | Zebrafish (Danio rerio). | whole-brain imaging in larval zebrafish; a zebrafish seizure model |
| `drosophila` | Drosophila (fruit flies). | mushroom body neurons in Drosophila; courtship behavior of flies |
| `c_elegans` (C. elegans) | Caenorhabditis elegans. | chemotaxis circuits in C. elegans; a C. elegans model of neurodegeneration |
| `other` | Any other species: other mammals (cats, dogs, pigs, ferrets, bats...), birds, amphibians, other fish, other invertebrates, and cells from other species. | zebra finch song learning; tectum of Xenopus tadpoles; octopus arm nerve cord |
| `none` (none, in silico) | No organism: pure theory, simulation, or a method tested on synthetic data. | a spiking network simulation; a filtering method tested on simulated signals |

### `population`: the condition studied

`healthy` when the study is about typical subjects only (healthy people, wild-type animals,
healthy aging); otherwise the condition or conditions. **Healthy controls in a patient study do
not add `healthy`.** An animal model of a disease counts as that disease. Write `-` when there
are no subjects at all.

| value | meaning | examples |
|---|---|---|
| `healthy` | Typical subjects only; no condition studied. | EEG in healthy young adults; place cells in wild-type mice; memory in healthy older adults |
| `epilepsy` | Epilepsy and seizures, including animal seizure models and developmental and epileptic encephalopathies. | SEEG in drug-resistant focal epilepsy; a kainate model of temporal lobe epilepsy; Dravet syndrome |
| `alzheimers` (Alzheimer's / dementia) | Alzheimer's disease and other dementias, mild cognitive impairment, amyloid and tau models. | amyloid PET in mild cognitive impairment; APP/PS1 mice; frontotemporal dementia |
| `parkinsons` (Parkinson's) | Parkinson's disease, parkinsonism and its models (MPTP, 6-OHDA, alpha-synuclein). | subthalamic DBS in Parkinson's disease; 6-OHDA lesioned rats; alpha-synuclein aggregation in neurons |
| `stroke` | Stroke and cerebrovascular disease: ischemic stroke, intracerebral or subarachnoid hemorrhage, aneurysms, small vessel disease, animal ischemia models. | outcomes after thrombectomy; middle cerebral artery occlusion in mice; post-stroke aphasia |
| `schizophrenia` (schizophrenia / psychosis) | Schizophrenia and psychosis, including clinical high risk and first episode. | auditory hallucinations in schizophrenia; a first-episode psychosis cohort |
| `depression` | Depression: major depressive disorder, depressive symptoms, treatment-resistant depression, depression models. | ketamine in treatment-resistant depression; rumination and fMRI in major depression; a chronic stress model of depression in mice |
| `bipolar` | Bipolar disorder. | lithium response in bipolar disorder; sleep and mania |
| `autism` | Autism spectrum disorder and autism models. | speech tracking in autistic children; Shank3 mutant mice |
| `adhd` (ADHD) | Attention-deficit/hyperactivity disorder. | methylphenidate and fMRI in ADHD; inattention in adults with ADHD |
| `multiple_sclerosis` (multiple sclerosis) | Multiple sclerosis and its models (EAE, cuprizone). | MRI lesions in relapsing-remitting MS; EAE mice |
| `tbi` (traumatic brain injury) | Traumatic brain injury and concussion, and their models. | concussion in athletes; controlled cortical impact in rats |
| `pain` | Pain: acute and chronic pain, nociception, neuropathic pain, headache and migraine. | chronic low back pain; migraine with aura; nociceptor sensitization in mice |
| `sleep` (sleep disorders) | Sleep disorders: insomnia, sleep apnea, narcolepsy, REM sleep behavior disorder, restless legs, circadian rhythm disorders. Sleep in healthy people is `healthy`. | narcolepsy type 1; obstructive sleep apnea and cognition; cognitive behavioral therapy for insomnia |
| `other_condition` (other condition) | Any other condition: brain tumors, ALS, Huntington's disease, ataxias, dystonia, neuropathies, spinal cord injury, infections, anxiety, PTSD, OCD, addiction, neurodevelopmental syndromes, hearing or vision loss, conditions outside the nervous system. | glioblastoma; alcohol use disorder; spinal cord injury in rats |

### `subfield`: the paper's main angle

One value. When two fit equally well, pick the one that best describes the paper's main question
and name the other in `notes`.

| value | meaning | examples |
|---|---|---|
| `cognitive` | Cognitive neuroscience: perception, attention, memory, language, emotion, decision-making, consciousness, social cognition, usually with task-based measures. | EEG of predictive processing in speech; fMRI of episodic memory retrieval |
| `systems` | Systems neuroscience: circuits, networks and neural coding; how populations of neurons and brain areas produce behavior, often in animals. | hippocampal place-cell sequences; a thalamocortical circuit for arousal |
| `clinical` (clinical / translational) | Clinical and translational neuroscience: diagnosis, prognosis, treatment and biomarkers of a condition, in patients or in disease models aimed at therapy; case reports. | a trial of DBS for depression; MRI predictors of outcome after stroke; a case report of autoimmune encephalitis |
| `computational` | Computational neuroscience: theory and models of neural function (biophysical, network, normative, cognitive models). | a normative model of grid cells; a neural mass model of EEG rhythms |
| `developmental` | Developmental neuroscience: development of the nervous system and of brain function, from embryo to adolescence (neurogenesis, migration, maturation). | cortical interneuron migration in the embryo; infant brain maturation with MRI |
| `cellular` (cellular / molecular) | Cellular and molecular neuroscience: cells, synapses, channels, receptors, genes, signaling pathways, glia. | gating of a sodium channel; microglial engulfment of synapses; a signaling pathway in neuronal survival |
| `methods` (methods / tools) | Methods and tools: new methods, software, hardware, datasets, atlases, protocols, benchmarks. | an open-source EEG preprocessing toolbox; a public MRI dataset; a new flexible electrode array |

## A filled row, for illustration (invented paper)

| on_topic | modality | organism | population | subfield | notes |
|---|---|---|---|---|---|
| `yes` | `eeg` | `human` | `epilepsy` | `clinical` | EEG plus a reaction-time task: not `behavior`, which means behavior only |
| `no` | | | | | a survey of nurses' working hours |
| `yes` | `modeling` | `none` | `-` | `computational` | |
| `yes` | `fmri; ?` | `human` | `healthy` | `cognitive` | the abstract does not say if MEG was also used |

## After labelling

Say so to the coordinator. The comparison then runs by night, when a model may use the GPU
(01:00 to 07:00, D6):

```
.venv/bin/python tools/compare_models.py            # between 01:00 and 07:00
.venv/bin/python tools/compare_models.py --report-only   # the report, at any time
```

It stops by itself at 07:00 and resumes the next night where it stopped. Its report
(`data/annotation/comparison.md`) gives, for the rules alone, each model alone, and the rules with
a model on the ambiguous cases only: the accuracy of `on_topic` and `subfield`, precision and
recall of the off-topic detection, precision / recall / F1 of `modality`, `organism` and
`population`, and each model's time per paper. It quotes no paper.
