# Contributing to ConvChain Studio

Thank you for your interest in contributing to ConvChain Studio! This document provides guidelines for contributing to the project.

## Code of Conduct

Be respectful, constructive, and inclusive in all interactions.

## How to Contribute

### Reporting Issues

- Use the GitHub issue tracker
- Describe the bug/feature clearly
- Include steps to reproduce (for bugs)
- Mention your environment (OS, Node version, etc.)

### Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Add tests if applicable
5. Update documentation as needed
6. Commit your changes (`git commit -m 'Add amazing feature'`)
7. Push to your fork (`git push origin feature/amazing-feature`)
8. Open a Pull Request

### Development Setup

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build
```

## Stepflow Compatibility

When making changes that affect workflow export/import:

1. Ensure generated YAML/JSON remains valid Stepflow format
2. Test import with actual Stepflow workflows
3. Update the compatibility layer in `shared/src/stepflow.ts` if needed
4. Document any new node types or features

## License Headers

New source files should include the Apache 2.0 license header:

```typescript
/**
 * Copyright 2025 [Your Name]
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * ...
 */
```

## Attribution

This project integrates with [Stepflow](https://stepflow.org) by DataStax Inc. 
When contributing features related to Stepflow compatibility, please:

- Reference the official Stepflow documentation
- Test against the Stepflow CLI when possible
- Maintain compatibility with the Stepflow protocol

## Questions?

- Open a GitHub Discussion
- Check the Stepflow documentation: https://stepflow.org/docs

Thank you for contributing!
