/**
 * Router pieces the help page uses, re-exported for the spec tests (the test workspace does not
 * depend on react-router itself; resolving from here uses the H5 app's own copy).
 */
export { MemoryRouter, useLocation, useNavigate, useSearchParams } from 'react-router';
