#ifndef GEO_CANVAS_H
#define GEO_CANVAS_H

#include <vector>
#include "shape.h"

namespace geo {

class Canvas {
public:
    void plot(int x, int y);
    void line(Point a, Point b);
    void render(const std::vector<std::unique_ptr<Shape>>& shapes);
    int pixelCount() const;
private:
    std::vector<Point> pixels_;
};

} // namespace geo

#endif
