"""Retraction Watch notices, looked up locally by DOI."""
from oscr.sources import retractions

CSV = ('Record ID,Title,Subject,Institution,Journal,Publisher,Country,Author,URLS,ArticleType,RetractionDate,'
       'RetractionDOI,RetractionPubMedID,OriginalPaperDate,OriginalPaperDOI,OriginalPaperPubMedID,RetractionNature,'
       'Reason,Paywalled,Notes,\n'
       '1,"An invented paper",,,J,P,,A,,Research Article;,8/7/2026 0:00,10.1/notice,0,3/7/2026 0:00,10.1/PAPER,0,'
       'Retraction,+Duplication of Image;+Paper Mill;,No,,\n'
       '2,"Another",,,J,P,,A,,Research Article;,9/1/2026 0:00,unavailable,0,1/1/2026 0:00,10.1/other,0,'
       'Expression of concern,+Concerns/Issues About Data;,No,,\n'
       '3,"No DOI",,,J,P,,A,,,1/1/2026 0:00,,0,,Unavailable,0,Retraction,,No,,\n')


def test_notices_are_indexed_by_the_original_doi(tmp_path):
    path = tmp_path / "rw.csv"
    path.write_text(CSV)
    n = retractions.notices(path)
    assert set(n) == {"10.1/paper", "10.1/other"}
    assert n["10.1/paper"] == [{"kind": "retraction", "id": "10.1/notice", "date": "8/7/2026",
                                "reasons": "Duplication of Image; Paper Mill", "source": "retraction-watch"}]
    assert n["10.1/other"][0]["kind"] == "concern" and n["10.1/other"][0]["id"] == "rw:2"
