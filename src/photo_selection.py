"""Choose a small, varied gallery without image APIs or extra provider requests."""
import re


def category(text):
    text = text.lower()
    for name, pattern in [
        ("dashboard", r"odometer|speedometer|tachometer|instrument cluster"),
        ("interior", r"\bcabin\b|\binterior\b|seating surfaces|front seats|rear seats"),
        ("underbody", r"underbody|undercarriage|underside|power (?:is )?(?:sent|routed|delivered)"),
        ("engine", r"engine bay|engine compartment|\bv8\b|\bv6\b|inline-six|\bengine\b"),
        ("exterior", r"\bexterior\b|finished in|bodywork"),
    ]:
        if re.search(pattern, text):
            return name
    return ""


def select_photos(urls, preferred=(), limit=8):
    """Keep the cover, prefer distinct described views, then sample the full gallery."""
    urls = list(dict.fromkeys(urls))
    if not urls:
        return []
    result = [urls[0]]
    used_categories = set()
    for url, description in preferred:
        kind = category(description)
        if kind and kind not in used_categories:
            used_categories.add(kind)
            if url not in result:
                result.append(url)
        if len(result) >= limit:
            return result[:limit]
    # Stable, evenly spaced choices avoid the old first-eight-exterior bias.
    if len(urls) > 1:
        for i in range(1, limit):
            url = urls[round(i * (len(urls) - 1) / (limit - 1))]
            if url not in result:
                result.append(url)
            if len(result) >= limit:
                return result
    for url in urls:
        if url not in result:
            result.append(url)
        if len(result) >= limit:
            break
    return result[:limit]
