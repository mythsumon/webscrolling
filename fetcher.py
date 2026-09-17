"""HTTP fetching: one polite session with robots.txt checks, retries and rate limiting."""
import time
import random
import urllib.robotparser as robotparser
from urllib.parse import urlparse

import requests

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


class Fetcher:
    def __init__(self, delay=1.5, jitter=0.5, timeout=20, retries=3,
                 user_agent=DEFAULT_UA, obey_robots=True):
        self.delay = delay
        self.jitter = jitter
        self.timeout = timeout
        self.retries = retries
        self.obey_robots = obey_robots
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        })
        self._robots = {}
        self._last_request = 0.0

    # -- robots.txt -------------------------------------------------------
    def allowed(self, url):
        if not self.obey_robots:
            return True
        parts = urlparse(url)
        root = f"{parts.scheme}://{parts.netloc}"
        rp = self._robots.get(root)
        if rp is None:
            rp = robotparser.RobotFileParser()
            rp.set_url(root + "/robots.txt")
            try:
                rp.read()
            except Exception:
                # No reachable robots.txt -> nothing disallowed.
                rp.parse([])
            self._robots[root] = rp
        return rp.can_fetch(self.session.headers["User-Agent"], url)

    # -- fetching ---------------------------------------------------------
    def _wait(self):
        elapsed = time.time() - self._last_request
        pause = self.delay + random.uniform(0, self.jitter) - elapsed
        if pause > 0:
            time.sleep(pause)

    def get(self, url):
        """Return HTML text, or None if blocked/failed."""
        if not self.allowed(url):
            print(f"  [robots] disallowed, skipping: {url}")
            return None

        for attempt in range(1, self.retries + 1):
            self._wait()
            try:
                resp = self.session.get(url, timeout=self.timeout)
                self._last_request = time.time()
                if resp.status_code == 429 or resp.status_code >= 500:
                    backoff = min(60, 2 ** attempt * 2)
                    print(f"  [{resp.status_code}] backing off {backoff}s ({url})")
                    time.sleep(backoff)
                    continue
                resp.raise_for_status()
                return resp.text
            except requests.RequestException as exc:
                self._last_request = time.time()
                if attempt == self.retries:
                    print(f"  [error] {url}: {exc}")
                    return None
                time.sleep(2 ** attempt)
        return None
