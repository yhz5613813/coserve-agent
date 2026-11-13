"""Portable CoServe thermal API. Importing this package starts no backend or job."""
__version__ = "0.3.1"


def run_simulation(request, output):
    """Solve one frozen request in an owned CPU child process and return its manifest."""
    from .bridge import run_simulation as run
    return run(request, output)
