"""Open Scientific Code Registry (OSCR): the registry of the native code of neuroscience papers.

For a paper, OSCR finds where its code is referenced, in its own text, in its
metadata, on the forges, verifies that this code exists, imports it into the
library and keeps the public catalog of it.

The library is designed for what comes next: every script carries an ORIGIN
(`native` today; `generated` and `author` the day generated scripts and authors'
corrections arrive). Neither of those two is coded here.
"""

__version__ = "0.2.0"
